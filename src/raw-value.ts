import {
    apply,
    assign,
    construct,
    ReflectSetPrototypeOf,
    freeze,
    isFunction,
    ObjectCreate,
    isUndefined,
    ReflectGetOwnPropertyDescriptor,
    ReflectDefineProperty,
    ErrorCreate,
    ReflectGetPrototypeOf,
    map,
    isNullish,
    unconstruct,
    ownKeys,
    ReflectIsExtensible,
    ReflectPreventExtensions,
    deleteProperty,
} from './shared';
import {
    ReverseProxyTarget,
    RawValue,
    RawObject,
    SecureConstructor,
    SecureFunction,
    ReverseShadowTarget,
    ReverseProxy,
    RawFunction,
    SecureArray,
    RawArray,
    SecureValue,
    MembraneBroker,
    SecureObject,
} from './types';

function renameFunction(provider: (...args: any[]) => any, receiver: (...args: any[]) => any) {
    let nameDescriptor: PropertyDescriptor | undefined;
    try {
        // a revoked proxy will break the membrane when reading the function name
        nameDescriptor = ReflectGetOwnPropertyDescriptor(provider, 'name');
    } catch (_ignored) {
        // intentionally swallowing the error because this method is just extracting the function
        // in a way that it should always succeed except for the cases in which the provider is a proxy
        // that is either revoked or has some logic to prevent reading the name property descriptor.
    }
    if (!isUndefined(nameDescriptor)) {
        ReflectDefineProperty(receiver, 'name', nameDescriptor);
    }
}

// it means it does have identity and should be proxified.
function isProxyTarget(o: RawValue): o is (SecureFunction | SecureConstructor | SecureObject) {
    // hire-wired for the common case
    if (isNullish(o)) {
        return false;
    }
    const t = typeof o;
    return t === 'object' || t === 'function';
}

const ProxyRevocable = Proxy.revocable;
const ProxyCreate = unconstruct(Proxy);
const { isArray: isArrayOrNotOrThrowForRevoked } = Array;
const emptyArray: [] = [];

function createReverseShadowTarget(target: ReverseProxyTarget): ReverseShadowTarget {
    let shadowTarget;
    if (isFunction(target)) {
        // this is never invoked just needed to anchor the realm
        try {
            shadowTarget = 'prototype' in target ? function () {} : () => {};
        } catch {
            // TODO: target is a revoked proxy. This could be optimized if Meta becomes available here.
            shadowTarget = () => {};
        }
        renameFunction(target as (...args: any[]) => any, shadowTarget as (...args: any[]) => any);
    } else {
        // o is object
        shadowTarget = {};
    }
    return shadowTarget;
}

// equivalent to Object.getOwnPropertyDescriptor, but looks into the whole proto chain
function getPropertyDescriptor(o: any, p: PropertyKey): PropertyDescriptor | undefined {
    do {
        const d = ReflectGetOwnPropertyDescriptor(o, p);
        if (!isUndefined(d)) {
            ReflectSetPrototypeOf(d, null);
            return d;
        }
        o = ReflectGetPrototypeOf(o);
    } while (o !== null);
    return undefined;
}

export function reverseProxyFactory(env: MembraneBroker) {

    function getRawDescriptor(secDesc: PropertyDescriptor): PropertyDescriptor {
        const rawDesc = assign(ObjectCreate(null), secDesc);
        const { value, get, set } = rawDesc;
        if ('writable' in rawDesc) {
            // we are dealing with a value descriptor
            rawDesc.value = isFunction(value) ?
                // we are dealing with a method (optimization)
                getRawFunction(value) : getRawValue(value);
        } else {
            // we are dealing with accessors
            if (isFunction(set)) {
                rawDesc.set = getRawFunction(set);
            }
            if (isFunction(get)) {
                rawDesc.get = getRawFunction(get);
            }
        }
        return rawDesc;
    }

    function getSecurePartialDescriptor(rawPartialDesc: PropertyDescriptor): PropertyDescriptor {
        const secPartialDesc = assign(ObjectCreate(null), rawPartialDesc);
        if ('value' in secPartialDesc) {
            // we are dealing with a value descriptor
            secPartialDesc.value = env.getSecureValue(secPartialDesc.value);
        }
        if ('set' in secPartialDesc) {
            // we are dealing with accessors
            secPartialDesc.set = env.getSecureValue(secPartialDesc.set);
        }
        if ('get' in secPartialDesc) {
            secPartialDesc.get = env.getSecureValue(secPartialDesc.get);
        }
        return secPartialDesc;
    }

    function lockShadowTarget(shadowTarget: ReverseShadowTarget, originalTarget: ReverseProxyTarget) {
        const targetKeys = ownKeys(originalTarget);
        for (let i = 0, len = targetKeys.length; i < len; i += 1) {
            const key = targetKeys[i];
            const rawDesc = ReflectGetOwnPropertyDescriptor(shadowTarget, key);
            if (isUndefined(rawDesc) || rawDesc.configurable === true) {
                const secDesc = ReflectGetOwnPropertyDescriptor(originalTarget, key) as PropertyDescriptor;
                ReflectDefineProperty(shadowTarget, key, getRawDescriptor(secDesc));
            }
        }
        ReflectPreventExtensions(shadowTarget);
    }

    class ReverseProxyHandler implements ProxyHandler<ReverseProxyTarget> {
        // original target for the proxy
        private readonly target: ReverseProxyTarget;

        constructor(target: ReverseProxyTarget) {
            this.target = target;
            // future optimization: hoping that proxies with frozen handlers can be faster
            freeze(this);
        }
        get(shadowTarget: ReverseShadowTarget, key: PropertyKey, receiver: RawObject): SecureValue {
            const { target } = this;
            const desc = getPropertyDescriptor(target, key);
            if (isUndefined(desc)) {
                return desc;
            }
            const { get } = desc;
            if (isFunction(get)) {
                // calling the getter with the raw receiver because the getter expects a raw value
                // it also returns a raw value
                return apply(env.getRawValue(get), receiver, emptyArray);
            }
            return env.getRawValue(desc.value);
        }
        set(shadowTarget: ReverseShadowTarget, key: PropertyKey, value: RawValue, receiver: RawObject): boolean {
            const { target } = this;
            const secDesc = getPropertyDescriptor(target, key);
            if (!isUndefined(secDesc)) {
                // descriptor exists in the target or proto chain
                const { set, get, writable } = secDesc;
                if (writable === false) {
                    // TypeError: Cannot assign to read only property '${key}' of object
                    return false;
                }
                if (isFunction(set)) {
                    // calling the setter with the raw receiver and the raw value
                    // because the setter expects a raw value it also returns a raw value
                    apply(env.getRawValue(set), receiver, [value]);
                    return true;
                }
                if (isFunction(get)) {
                    // a getter without a setter should fail to set in strict mode
                    // TypeError: Cannot set property ${key} of object which has only a getter
                    return false;
                }
            } else if (!ReflectIsExtensible(shadowTarget)) {
                // non-extensible should throw in strict mode
                // TypeError: Cannot add property ${key}, object is not extensible
                return false;
            }
            // the descriptor is writable on the obj or proto chain, just assign it
            target[key] = env.getSecureValue(value);
            return true;
        }
        deleteProperty(shadowTarget: ReverseShadowTarget, key: PropertyKey): boolean {
            const { target } = this;
            return deleteProperty(target, key);
        }
        apply(shadowTarget: ReverseShadowTarget, rawThisArg: RawValue, rawArgArray: RawValue[]): RawValue {
            const { target } = this;
            const secThisArg = env.getSecureValue(rawThisArg);
            const secArgArray = env.getSecureValue(rawArgArray);
            let sec;
            try {
                sec = apply(target as SecureFunction, secThisArg, secArgArray);
            } catch (e) {
                // This error occurred when the outer realm attempts to call a
                // function from the sandbox. By throwing a new raw error, we eliminates the stack
                // information from the sandbox as a consequence.
                let rawError;
                const { message } = e;
                try {
                    // the error prototype must be a secure error since it occur when calling
                    // a function from the sandbox.
                    const rawErrorProto = env.getRawRef(ReflectGetPrototypeOf(e));
                    // the raw prototype must be registered (done during construction of env)
                    // otherwise we need to fallback to a regular error.
                    rawError = construct(rawErrorProto.constructor as RawFunction, [message]);
                } catch {
                    // in case the constructor inference fails
                    rawError = ErrorCreate(message);
                }
                throw rawError;
            }
            return env.getRawValue(sec);
        }
        construct(shadowTarget: ReverseShadowTarget, rawArgArray: RawValue[], rawNewTarget: RawObject): RawObject {
            const { target: SecCtor } = this;
            if (rawNewTarget === undefined) {
                throw TypeError();
            }
            const secArgArray = env.getSecureValue(rawArgArray);
            const secNewTarget = env.getSecureValue(rawNewTarget);
            let sec;
            try {
                sec = construct(SecCtor as SecureConstructor, secArgArray, secNewTarget);
            } catch (e) {
                // This error occurred when the outer realm attempts to new a
                // constructor from the sandbox. By throwing a new raw error, we eliminates the stack
                // information from the sandbox as a consequence.
                let rawError;
                const { message } = e;
                try {
                    // the error prototype must be a secure error since it occur when calling
                    // a function from the sandbox.
                    const rawErrorProto = env.getRawRef(ReflectGetPrototypeOf(e));
                    // the raw prototype must be registered (done during construction of env)
                    // otherwise we need to fallback to a regular error.
                    rawError = construct(rawErrorProto.constructor as RawFunction, [message]);
                } catch {
                    // in case the constructor inference fails
                    rawError = ErrorCreate(message);
                }
                throw rawError;
            }
            return env.getRawValue(sec);
        }
        has(shadowTarget: ReverseShadowTarget, key: PropertyKey): boolean {
            const { target } = this;
            return key in target;
        }
        ownKeys(shadowTarget: ReverseShadowTarget): PropertyKey[] {
            const { target } = this;
            return ownKeys(target);
        }
        isExtensible(shadowTarget: ReverseShadowTarget): boolean {
            if (!ReflectIsExtensible(shadowTarget)) {
                return false; // was already locked down
            }
            const { target } = this;
            if (!ReflectIsExtensible(target)) {
                lockShadowTarget(shadowTarget, target);
                return false;
            }
            return true;
        }
        getOwnPropertyDescriptor(shadowTarget: ReverseShadowTarget, key: PropertyKey): PropertyDescriptor | undefined {
            const { target } = this;
            let rawDesc = ReflectGetOwnPropertyDescriptor(shadowTarget, key);
            if (!isUndefined(rawDesc)) {
                return rawDesc;
            }
            const secDesc = ReflectGetOwnPropertyDescriptor(target, key);
            if (isUndefined(secDesc)) {
                return secDesc;
            }
            rawDesc = getRawDescriptor(secDesc);
            if (secDesc.configurable === false) {
                // updating the descriptor to non-configurable on the shadow
                ReflectDefineProperty(shadowTarget, key, rawDesc);
            }
            return rawDesc;
        }
        getPrototypeOf(shadowTarget: ReverseShadowTarget): RawValue {
            const { target } = this;
            return env.getRawValue(ReflectGetPrototypeOf(target));
        }
        setPrototypeOf(shadowTarget: ReverseShadowTarget, prototype: RawValue): boolean {
            const { target } = this;
            return ReflectSetPrototypeOf(target, env.getSecureValue(prototype));
        }
        preventExtensions(shadowTarget: ReverseShadowTarget): boolean {
            const { target } = this;
            if (ReflectIsExtensible(shadowTarget)) {
                if (!ReflectPreventExtensions(target)) {
                    // if the target is a proxy manually created in the sandbox, it might reject
                    // the preventExtension call, in which case we should not attempt to lock down
                    // the shadow target.
                    if (!ReflectIsExtensible(target)) {
                        lockShadowTarget(shadowTarget, target);
                    }
                    return false;
                }
                lockShadowTarget(shadowTarget, target);
            }
            return true;
        }
        defineProperty(shadowTarget: ReverseShadowTarget, key: PropertyKey, rawPartialDesc: PropertyDescriptor): boolean {
            const { target } = this;
            const secDesc = getSecurePartialDescriptor(rawPartialDesc);
            if (ReflectDefineProperty(target, key, secDesc)) {
                // intentionally testing against true since it could be undefined as well
                if (secDesc.configurable === false) {
                    // defining the descriptor to non-configurable on the shadow target
                    ReflectDefineProperty(shadowTarget, key, rawPartialDesc);
                }
            }
            return true;
        }
    }

    ReflectSetPrototypeOf(ReverseProxyHandler.prototype, null);

    function getRawValue(sec: SecureValue): RawValue {
        let isSecArray = false;
        try {
            isSecArray = isArrayOrNotOrThrowForRevoked(sec);
        } catch {
            return getRevokedReverseProxy(sec);
        }
        if (isSecArray) {
            return getRawArray(sec);
        } else if (isProxyTarget(sec)) {
            const raw = env.getRawRef(sec);
            if (isUndefined(raw)) {
                return createReverseProxy(sec);
            }
            return raw;
        }
        return sec as RawValue;
    }

    function getRawFunction(fn: SecureFunction): RawFunction {
        const raw = env.getRawRef(fn);
        if (isUndefined(raw)) {
            try {
                // just in case the fn is a revoked proxy (extra protection)
                isArrayOrNotOrThrowForRevoked(fn);
            } catch {
                return getRevokedReverseProxy(fn) as RawFunction;
            }
            return createReverseProxy(fn) as RawFunction;
        }
        return raw as SecureFunction;
    }

    function getRawArray(a: SecureArray): RawArray {
        // identity of the new array correspond to the outer realm
        return map(a, (sec: SecureValue) => getRawValue(sec));
    }

    function getRevokedReverseProxy(sec: ReverseProxyTarget): ReverseProxy {
        const shadowTarget = createReverseShadowTarget(sec);
        const { proxy, revoke } = ProxyRevocable(shadowTarget, {});
        env.createSecureRecord(sec, proxy);
        revoke();
        return proxy;
    }

    function createReverseProxy(sec: ReverseProxyTarget): ReverseProxy {
        const shadowTarget = createReverseShadowTarget(sec);
        const proxyHandler = new ReverseProxyHandler(sec);
        const proxy = ProxyCreate(shadowTarget, proxyHandler);
        env.createSecureRecord(sec, proxy);
        return proxy;
    }

    return getRawValue;

}
