/**
 * This file implements a serializable factory function that is invoked once per sandbox
 * and it is used to create secure proxies where all identities are defined inside
 * the sandbox, this guarantees that any error when interacting with those proxies, has
 * the proper identity to avoid leaking references from the outer realm into the sandbox
 * this is especially important for out of memory errors.
 *
 * IMPORTANT:
 *  - This file can't import anything from the package, only types since it is going to
 *    be serialized, and therefore it will loose the reference.
 */
import {
    SecureProxyTarget,
    SecureValue,
    SecureObject,
    SecureShadowTarget,
    SecureFunction,
    SecureArray,
    SecureProxy,
    RawConstructor,
    RawFunction,
    RawValue,
    RawObject,
    RawArray,
    SecureRecord,
    TargetMeta,
    MembraneBroker,
} from './types';

/**
 * Blink (Chrome) imposes certain restrictions for detached iframes, specifically,
 * any callback (or potentially a constructor) invoked from a detached iframe
 * will throw an error as detailed here:
 *
 *  - https://bugs.chromium.org/p/chromium/issues/detail?id=1042435#c4
 *
 * This restriction seems some-how arbitrary at this point because you can easily
 * bypass it by preserving the following two invariants:
 *
 * 1. a call to a dom DOM API must be done from the main window.
 * 2. any callback passed into a DOM API must be wrapped with a
 *    proxy from the main realm.
 *
 * For that, the environment must provide two hooks that when called
 * they will delegate to Reflect.apply/Reflect.construct on the outer
 * realm, you cannot call Reflect.* from inside the sandbox or the outer
 * realm directly, it must be a wrapping function.
 */
export interface MarshalHooks {
    apply(target: RawFunction, thisArgument: RawValue, argumentsList: ArrayLike<RawValue>): RawValue;
    construct(target: RawConstructor, argumentsList: ArrayLike<RawValue>, newTarget?: any): RawValue;
}

export const serializedSecureEnvSourceText = (function secureEnvFactory(rawEnv: MembraneBroker, hooks: MarshalHooks) {
    'use strict';

    const { rom, distortionMap } = rawEnv;
    const { apply: rawApplyHook, construct: rawConstructHook } = hooks;

    const {
        apply,
        construct,
        isExtensible,
        getOwnPropertyDescriptor,
        setPrototypeOf,
        getPrototypeOf,
        preventExtensions,
        deleteProperty,
        ownKeys,
        defineProperty,
    } = Reflect;
    const {
        assign,
        create,
        defineProperty: ObjectDefineProperty,
        getOwnPropertyDescriptors,
        freeze,
        seal,
        isSealed,
        isFrozen,
        hasOwnProperty,
    } = Object;
    const ProxyRevocable = Proxy.revocable;
    const ProxyCreate = unconstruct(Proxy);
    const { isArray: isArrayOrNotOrThrowForRevoked } = Array;
    const emptyArray: [] = [];
    const noop = () => undefined;
    const map = unapply(Array.prototype.map);
    const WeakMapGet = unapply(WeakMap.prototype.get);
    const WeakMapHas = unapply(WeakMap.prototype.has);
    const ErrorCreate = unconstruct(Error);

    function unapply(func: Function): Function {
        return (thisArg: any, ...args: any[]) => apply(func, thisArg, args);
    }

    function unconstruct(func: Function): Function {
        return (...args: any[]) => construct(func, args);
    }

    function isUndefined(obj: any): obj is undefined {
        return obj === undefined;
    }

    function isFunction(obj: any): obj is Function {
        return typeof obj === 'function';
    }

    function isNullish(obj: any): obj is null {
        // eslint-disable-next-line eqeqeq
        return obj == null;
    }

    function getSecureValue(raw: RawValue): SecureValue {
        let isRawArray = false;
        try {
            isRawArray = isArrayOrNotOrThrowForRevoked(raw);
        } catch {
            // raw was revoked - but we call createSecureProxy to support distortions
            return createSecureProxy(raw);
        }
        if (isRawArray) {
            return getSecureArray(raw);
        } else if (isProxyTarget(raw)) {
            const sr: SecureRecord | undefined = WeakMapGet(rom, raw);
            if (isUndefined(sr)) {
                return createSecureProxy(raw);
            }
            return sr.sec;
        } else {
            return raw as SecureValue;
        }
    }

    function getSecureArray(a: RawArray): SecureArray {
        const b: SecureValue[] = map(a, (raw: RawValue) => getSecureValue(raw));
        // identity of the new array correspond to the inner realm
        return [...b];
    }

    function getSecureFunction(fn: RawFunction): SecureFunction {
        const sr: SecureRecord | undefined = WeakMapGet(rom, fn);
        if (isUndefined(sr)) {
            return createSecureProxy(fn) as SecureFunction;
        }
        return sr.sec as SecureFunction;
    }

    function getDistortedValue(target: SecureProxyTarget): SecureProxyTarget {
        if (!WeakMapHas(distortionMap, target)) {
            return target;
        }
        // if a distortion entry is found, it must be a valid proxy target
        const distortedTarget = WeakMapGet(distortionMap, target) as SecureProxyTarget;
        if (!isProxyTarget(distortedTarget)) {
            // TODO: needs to be resilient, cannot just throw, what should we do instead?
            throw ErrorCreate(`Invalid distortion.`);
        }
        return distortedTarget;
    }

    // it means it does have identity and should be proxified.
    function isProxyTarget(o: RawValue | SecureValue): o is (RawFunction | RawConstructor | RawObject) {
        // hire-wired for the common case
        if (isNullish(o)) {
            return false;
        }
        const t = typeof o;
        return t === 'object' || t === 'function';
    }

    function renameFunction(rawProvider: (...args: any[]) => any, receiver: (...args: any[]) => any) {
        let nameDescriptor: PropertyDescriptor | undefined;
        try {
            // a revoked proxy will break the membrane when reading the function name
            nameDescriptor = getOwnPropertyDescriptor(rawProvider, 'name');
        } catch (_ignored) {
            // intentionally swallowing the error because this method is just extracting the function
            // in a way that it should always succeed except for the cases in which the provider is a proxy
            // that is either revoked or has some logic to prevent reading the name property descriptor.
        }
        if (!isUndefined(nameDescriptor)) {
            defineProperty(receiver, 'name', nameDescriptor);
        }
    }    

    function installDescriptorIntoShadowTarget(shadowTarget: SecureProxyTarget, key: PropertyKey, originalDescriptor: PropertyDescriptor) {
        const shadowTargetDescriptor = getOwnPropertyDescriptor(shadowTarget, key);
        if (!isUndefined(shadowTargetDescriptor)) {
            if (hasOwnProperty.call(shadowTargetDescriptor, 'configurable') &&
                    shadowTargetDescriptor.configurable === true) {
                defineProperty(shadowTarget, key, originalDescriptor);
            } else if (hasOwnProperty.call(shadowTargetDescriptor, 'writable') &&
                    shadowTargetDescriptor.writable === true) {
                // just in case
                shadowTarget[key] = originalDescriptor.value;
            } else {
                // ignoring... since it is non configurable and non-writable
                // usually, arguments, callee, etc.
            }
        } else {
            defineProperty(shadowTarget, key, originalDescriptor);
        }
    }

    function getSecureDescriptor(rawDescriptor: PropertyDescriptor): PropertyDescriptor {
        const secureDescriptor = assign(create(null), rawDescriptor);
        const { value: rawValue, get: rawGet, set: rawSet } = secureDescriptor;
        if ('writable' in secureDescriptor) {
            // we are dealing with a value descriptor
            secureDescriptor.value = isFunction(rawValue) ?
                // we are dealing with a method (optimization)
                getSecureFunction(rawValue) : getSecureValue(rawValue);
        } else {
            // we are dealing with accessors
            if (isFunction(rawSet)) {
                secureDescriptor.set = getSecureFunction(rawSet);
            }
            if (isFunction(rawGet)) {
                secureDescriptor.get = getSecureFunction(rawGet);
            }
        }
        return secureDescriptor;
    }

    // equivalent to Object.getOwnPropertyDescriptor, but looks into the whole proto chain
    function getPropertyDescriptor(o: any, p: PropertyKey): PropertyDescriptor | undefined {
        do {
            const d = getOwnPropertyDescriptor(o, p);
            if (!isUndefined(d)) {
                setPrototypeOf(d, null);
                return d;
            }
            o = getPrototypeOf(o);
        } while (o !== null);
        return undefined;
    }

    function copySecureOwnDescriptors(shadowTarget: SecureShadowTarget, rawDescriptors: PropertyDescriptorMap) {
        for (const key in rawDescriptors) {
            // avoid poisoning by checking own properties from descriptors
            if (hasOwnProperty.call(rawDescriptors, key)) {
                const originalDescriptor = getSecureDescriptor(rawDescriptors[key]);
                installDescriptorIntoShadowTarget(shadowTarget, key, originalDescriptor);
            }
        }
    }

    function getTargetMeta(target: SecureProxyTarget): TargetMeta {
        const meta: TargetMeta = create(null);
        try {
            // a revoked proxy will break the membrane when reading the meta
            meta.proto = getPrototypeOf(target);
            meta.descriptors = getOwnPropertyDescriptors(target);
            if (isFrozen(target)) {
                meta.isFrozen = meta.isSealed = meta.isExtensible = true;
            } else if (isSealed(target)) {
                meta.isSealed = meta.isExtensible = true;
            } else if (isExtensible(target)) {
                meta.isExtensible = true;
            }
            // if the target was revoked or become revoked during the extraction
            // of the metadata, we mark it as broken in the catch.
            isArrayOrNotOrThrowForRevoked(target);
        } catch (_ignored) {
            // intentionally swallowing the error because this method is just extracting the metadata
            // in a way that it should always succeed except for the cases in which the target is a proxy
            // that is either revoked or has some logic that is incompatible with the membrane, in which
            // case we will just create the proxy for the membrane but revoke it right after to prevent
            // any leakage.
            meta.proto = null;
            meta.descriptors = {};
            meta.isBroken = true;
        }
        return meta;
    }

    class SecureProxyHandler implements ProxyHandler<SecureProxyTarget> {
        // original target for the proxy
        private readonly target: SecureProxyTarget;
        // metadata about the shape of the target
        private readonly meta: TargetMeta;
    
        constructor(raw: SecureProxyTarget, meta: TargetMeta) {
            this.target = raw;
            this.meta = meta;
        }
        // initialization used to avoid the initialization cost
        // of an object graph, we want to do it when the
        // first interaction happens.
        initialize(shadowTarget: SecureShadowTarget) {
            const { meta } = this;
            const { proto: rawProto } = meta;
            // once the initialization is executed once... the rest is just noop 
            this.initialize = noop;
            // adjusting the proto chain of the shadowTarget (recursively)
            const secProto = getSecureValue(rawProto);
            setPrototypeOf(shadowTarget, secProto);
            // defining own descriptors
            copySecureOwnDescriptors(shadowTarget, meta.descriptors);
            // preserving the semantics of the object
            if (meta.isFrozen) {
                freeze(shadowTarget);
            } else if (meta.isSealed) {
                seal(shadowTarget);
            } else if (!meta.isExtensible) {
                preventExtensions(shadowTarget);
            }
            // future optimization: hoping that proxies with frozen handlers can be faster
            freeze(this);
        }
    
        get(shadowTarget: SecureShadowTarget, key: PropertyKey, receiver: SecureObject): SecureValue {
            this.initialize(shadowTarget);
            const desc = getPropertyDescriptor(shadowTarget, key);
            if (isUndefined(desc)) {
                return desc;
            }
            const { get } = desc;
            if (isFunction(get)) {
                // calling the getter with the secure receiver because the getter expects a secure value
                // it also returns a secure value
                return apply(get, receiver, emptyArray);
            }
            return desc.value;
        }
        set(shadowTarget: SecureShadowTarget, key: PropertyKey, value: SecureValue, receiver: SecureObject): boolean {
            this.initialize(shadowTarget);
            const shadowTargetDescriptor = getPropertyDescriptor(shadowTarget, key);
            if (!isUndefined(shadowTargetDescriptor)) {
                // descriptor exists in the shadowTarget or proto chain
                const { set, get, writable } = shadowTargetDescriptor;
                if (writable === false) {
                    // TypeError: Cannot assign to read only property '${key}' of object
                    return false;
                }
                if (isFunction(set)) {
                    // a setter is available, just call it with the secure value because
                    // the setter expects a secure value
                    apply(set, receiver, [value]);
                    return true;
                }
                if (isFunction(get)) {
                    // a getter without a setter should fail to set in strict mode
                    // TypeError: Cannot set property ${key} of object which has only a getter
                    return false;
                }
            } else if (!isExtensible(shadowTarget)) {
                // non-extensible should throw in strict mode
                // TypeError: Cannot add property ${key}, object is not extensible
                return false;
            }
            // the descriptor is writable on the obj or proto chain, just assign it
            shadowTarget[key] = value;
            return true;
        }
        deleteProperty(shadowTarget: SecureShadowTarget, key: PropertyKey): boolean {
            this.initialize(shadowTarget);
            return deleteProperty(shadowTarget, key);
        }
        apply(shadowTarget: SecureShadowTarget, thisArg: SecureValue, argArray: SecureValue[]): SecureValue {
            const { target: rawTarget } = this;
            this.initialize(shadowTarget);
            let raw;
            try {
                const rawThisArg = rawEnv.getRawValue(thisArg);
                const rawArgArray = rawEnv.getRawValue(argArray);
                raw = rawApplyHook(rawTarget as RawFunction, rawThisArg, rawArgArray);
            } catch (e) {
                // This error occurred when the sandbox attempts to call a
                // function from the outer realm. By throwing a new secure error,
                // we eliminates the stack information from the outer realm as a consequence.
                let secError;
                const { message } = e;
                try {
                    // the error prototype must be a raw error since it occur when calling
                    // a function from the outer realm.
                    const secErrorProto = rawEnv.getSecureRef(getPrototypeOf(e));
                    // the secure prototype must be registered (done during construction of env)
                    // otherwise we need to fallback to a regular error.
                    secError = construct(secErrorProto.constructor as SecureFunction, [message]);
                } catch {
                    // in case the constructor inference fails
                    secError = new Error(message);
                }
                throw secError;
            }
            return getSecureValue(raw);
        }
        construct(shadowTarget: SecureShadowTarget, secArgArray: SecureValue[], secNewTarget: SecureObject): SecureObject {
            const { target: rawCons } = this;
            this.initialize(shadowTarget);
            if (isUndefined(secNewTarget)) {
                throw TypeError();
            }
            let raw;
            try {
                const rawNewTarget = rawEnv.getRawValue(secNewTarget);
                const rawArgArray = rawEnv.getRawValue(secArgArray);
                raw = rawConstructHook(rawCons as RawConstructor, rawArgArray, rawNewTarget);
            } catch (e) {
                // This error occurred when the sandbox attempts to new a
                // constructor from the outer realm. By throwing a new secure error,
                // we eliminates the stack information from the outer realm as a consequence.
                let secError;
                const { message } = e;
                try {
                    // the error prototype must be a raw error since it occur when calling
                    // a function from the outer realm.
                    const secErrorProto = rawEnv.getSecureRef(getPrototypeOf(e));
                    // the secure prototype must be registered (done during construction of env)
                    // otherwise we need to fallback to a regular error.
                    secError = construct(secErrorProto.constructor as SecureFunction, [message]);
                } catch {
                    // in case the constructor inference fails
                    secError = new Error(message);
                }
                throw secError;
            }
            return getSecureValue(raw);
        }
        has(shadowTarget: SecureShadowTarget, key: PropertyKey): boolean {
            this.initialize(shadowTarget);
            return key in shadowTarget;
        }
        ownKeys(shadowTarget: SecureShadowTarget): PropertyKey[] {
            this.initialize(shadowTarget);
            return ownKeys(shadowTarget);
        }
        isExtensible(shadowTarget: SecureShadowTarget): boolean {
            this.initialize(shadowTarget);
            // No DOM API is non-extensible, but in the sandbox, the author
            // might want to make them non-extensible
            return isExtensible(shadowTarget);
        }
        getOwnPropertyDescriptor(shadowTarget: SecureShadowTarget, key: PropertyKey): PropertyDescriptor | undefined {
            this.initialize(shadowTarget);
            return getOwnPropertyDescriptor(shadowTarget, key);
        }
        getPrototypeOf(shadowTarget: SecureShadowTarget): SecureValue {
            this.initialize(shadowTarget);
            // nothing to be done here since the shadowTarget must have the right proto chain
            return getPrototypeOf(shadowTarget);
        }
        setPrototypeOf(shadowTarget: SecureShadowTarget, prototype: SecureValue): boolean {
            this.initialize(shadowTarget);
            // this operation can only affect the env object graph
            return setPrototypeOf(shadowTarget, prototype);
        }
        preventExtensions(shadowTarget: SecureShadowTarget): boolean {
            this.initialize(shadowTarget);
            // this operation can only affect the env object graph
            return preventExtensions(shadowTarget);
        }
        defineProperty(shadowTarget: SecureShadowTarget, key: PropertyKey, secPartialDesc: PropertyDescriptor): boolean {
            this.initialize(shadowTarget);
            // this operation can only affect the env object graph
            // intentionally using Object.defineProperty instead of Reflect.defineProperty
            // to throw for existing non-configurable descriptors.
            ObjectDefineProperty(shadowTarget, key, secPartialDesc);
            return true;
        }
    }
    

    setPrototypeOf(SecureProxyHandler.prototype, null);

    function createSecureShadowTarget(raw: SecureProxyTarget): SecureShadowTarget {
        let shadowTarget;
        if (isFunction(raw)) {
            // this is never invoked just needed to anchor the realm for errors
            try {
                shadowTarget = 'prototype' in raw ? function () {} : () => {};
            } catch {
                // TODO: target is a revoked proxy. This could be optimized if Meta becomes available here.
                shadowTarget = () => {};
            }
            renameFunction(raw as (...args: any[]) => any, shadowTarget);
        } else {
            // o is object
            shadowTarget = {};
        }
        return shadowTarget;
    }

    function getRevokedSecureProxy(raw: SecureProxyTarget): SecureProxy {
        const shadowTarget = createSecureShadowTarget(raw);
        const { proxy, revoke } = ProxyRevocable(shadowTarget, {});
        rawEnv.createSecureRecord(proxy, raw);
        revoke();
        return proxy;
    }

    function createSecureProxy(raw: SecureProxyTarget): SecureProxy {
        raw = getDistortedValue(raw);
        const meta = getTargetMeta(raw);
        let proxy;
        if (meta.isBroken) {
            proxy = getRevokedSecureProxy(raw);
        } else {
            const shadowTarget = createSecureShadowTarget(raw);
            const proxyHandler = new SecureProxyHandler(raw, meta);
            proxy = ProxyCreate(shadowTarget, proxyHandler);
        }
        try {
            rawEnv.createSecureRecord(proxy, raw);
        } catch (e) {
            // This is a very edge case, it could happen if someone is very
            // crafty, but basically can cause an overflow when invoking the
            // createSecureRecord() method, which will report an error from
            // the outer realm.
            throw ErrorCreate('Internal Error');
        }
        return proxy;
    }

    return getSecureValue;

}).toString();