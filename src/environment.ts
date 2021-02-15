import {
    apply,
    assign,
    isUndefined,
    ObjectCreate,
    isFunction,
    emptyArray,
    ErrorCreate,
    ObjectDefineProperties,
    ReflectGetOwnPropertyDescriptor,
    RegExpTest,
    WeakMapCreate,
    WeakMapSet,
    WeakMapGet,
    construct,
    isTrue,
    ownKeys,
} from './shared';
import { serializedRedEnvSourceText, MarshalHooks } from './red';
import { blueProxyFactory } from './blue';
import {
    RedObject,
    BlueFunction,
    BlueObject,
    RedProxyTarget,
    BlueValue,
    RedValue,
    BlueConstructor,
    MembraneBroker,
    DistortionMap,
    RedToBlueReferencesMap,
    BlueToRedReferencesMap,
} from './types';

const frameGlobalNamesRegExp = /^\d+$/;

interface SecureEnvironmentOptions {
    // Blue global object used by the blue environment
    blueGlobalThis: BlueObject & typeof globalThis;
    // Red global object used by the red environment
    redGlobalThis: RedObject & typeof globalThis;
    // Optional distortion map to tame functionalities observed through the membrane
    distortionMap?: Map<RedProxyTarget, RedProxyTarget>;
}

export class SecureEnvironment implements MembraneBroker {
    // map from red to blue references
    redMap: RedToBlueReferencesMap = WeakMapCreate();
    // map from blue to red references
    blueMap: BlueToRedReferencesMap = WeakMapCreate();
    // blue object distortion map
    distortionMap: DistortionMap;

    constructor(options: SecureEnvironmentOptions) {
        if (isUndefined(options)) {
            throw ErrorCreate(`Missing SecureEnvironmentOptions options bag.`);
        }
        const { redGlobalThis, distortionMap } = options;
        this.distortionMap = WeakMapCreate();
        // validating distortion entries
        distortionMap?.forEach((value, key) => {
            if (typeof key !== typeof value) {
                throw ErrorCreate(`Invalid distortion ${value}.`);
            }
            WeakMapSet(this.distortionMap, key, value);
        });
        // getting proxy factories ready per environment so we can produce
        // the proper errors without leaking instances into a sandbox
        const redEnvFactory = redGlobalThis.eval(`(${serializedRedEnvSourceText})`);
        // Important Note: removing the indirection for apply and construct breaks
        // chrome karma tests for some unknown reasons. What is seems harmless turns out
        // to be fatal, why? it seems that this is because Chrome does identity checks
        // on those intrinsics, and fails if the detached iframe is calling an intrinsic
        // from another realm.
        const blueHooks: MarshalHooks = {
            apply(target: BlueFunction, thisArgument: BlueValue, argumentsList: ArrayLike<BlueValue>): BlueValue {
                return apply(target, thisArgument, argumentsList);
            },
            construct(target: BlueConstructor, argumentsList: ArrayLike<BlueValue>, newTarget?: any): BlueValue {
                return construct(target, argumentsList, newTarget);
            },
        };
        this.getRedValue = redEnvFactory(this, blueHooks);
        this.getBlueValue = blueProxyFactory(this);
    }

    getBlueValue(red: RedValue): BlueValue {
        // placeholder since this will be assigned in construction
    }

    getRedValue(blue: BlueValue): RedValue {
        // placeholder since this will be assigned in construction
    }

    getBlueRef(red: RedValue): BlueValue | undefined {
        const blue: RedValue | undefined = WeakMapGet(this.redMap, red);
        if (!isUndefined(blue)) {
            return blue;
        }
    }

    getRedRef(blue: BlueValue): RedValue | undefined {
        const red: RedValue | undefined = WeakMapGet(this.blueMap, blue);
        if (!isUndefined(red)) {
            return red;
        }
    }

    setRefMapEntries(red: RedObject, blue: BlueObject) {
        // double index for perf
        WeakMapSet(this.redMap, red, blue);
        WeakMapSet(this.blueMap, blue, red);
    }

    remap(redValue: RedValue, blueValue: BlueValue, blueDescriptors: PropertyDescriptorMap) {
        const broker = this;
        const keys = ownKeys(blueDescriptors);
        const redDescriptors = ObjectCreate(null);
        for (let i = 0, len = keys.length; i < len; i += 1) {
            const key = keys[i];
            // Skip index keys for magical descriptors of frames on the window proxy.
            if (typeof key !== 'symbol' && RegExpTest(frameGlobalNamesRegExp, key)) {
                continue;
            }
            if (!canRedPropertyBeTamed(redValue, key)) {
                console.warn(`Property ${String(key)} of ${redValue} cannot be remapped.`);
                continue;
            }
            // Avoid poisoning by only installing own properties from blueDescriptors
            // @ts-expect-error because PropertyDescriptorMap does not accept symbols ATM.
            const blueDescriptor = assign(ObjectCreate(null), blueDescriptors[key]);
            const redDescriptor = assign(ObjectCreate(null), blueDescriptor);
            if ('value' in blueDescriptor) {
                redDescriptor.value = broker.getRedValue(blueDescriptor.value);
            } else {
                // Use the original getter to return a red object, but if the
                // sandbox attempts to set it to a new value, this mutation will
                // only affect the sandbox's global object, and the getter will
                // start returning the new provided value rather than calling onto
                // the blue realm. This is to preserve the object graph of the
                // blue realm.
                let currentBlueGetter: (this: RedValue) => RedValue = () => undefined;

                if (isFunction(blueDescriptor.get)) {
                    const { get: blueGetter } = blueDescriptor;
                    const blueDistortedGetter: () => BlueValue = WeakMapGet(this.distortionMap, blueGetter) || blueGetter;
                    currentBlueGetter = function() {
                        const value: BlueValue = apply(blueDistortedGetter, broker.getBlueValue(this), emptyArray);
                        return broker.getRedValue(value);
                    };
                    redDescriptor.get = function(): RedValue {
                        return apply(currentBlueGetter, this, emptyArray);
                    };
                }

                if (isFunction(blueDescriptor.set)) {
                    redDescriptor.set = function(v: RedValue): void {
                        // if a global setter is invoke, the value will be use as it is as the result of the getter operation
                        currentBlueGetter = () => v;
                    };
                }
            }
            redDescriptors[key] = redDescriptor;
        }
        // Use `ObjectDefineProperties()` instead of individual
        // `ReflectDefineProperty()` calls for better performance.
        ObjectDefineProperties(redValue, redDescriptors);
    }
}

function canRedPropertyBeTamed(redValue: RedValue, key: PropertyKey): boolean {
    const redDescriptor = ReflectGetOwnPropertyDescriptor(redValue, key);
    // TODO: what about writable - non-configurable?
    return isUndefined(redDescriptor) || isTrue(redDescriptor.configurable);
}
