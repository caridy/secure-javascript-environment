export const { isArray: ArrayIsArray } = Array;

export const {
    assign,
    create: ObjectCreate,
    defineProperty: ObjectDefineProperty,
    getOwnPropertyDescriptors,
    freeze,
    seal,
    isSealed,
    isFrozen,
} = Object;

export const {
    apply,
    construct,
    getPrototypeOf: ReflectGetPrototypeOf,
    setPrototypeOf: ReflectSetPrototypeOf,
    defineProperty: ReflectDefineProperty,
    isExtensible: ReflectIsExtensible,
    getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
    ownKeys,
    preventExtensions: ReflectPreventExtensions,
    deleteProperty,
} = Reflect;

const ErrorCreate = unconstruct(Error);
const SetCreate = unconstruct(Set);
const SetHas = unapply(Set.prototype.has);
const ProxyRevocable = Proxy.revocable;
const WeakMapCreate = unconstruct(WeakMap);
const WeakMapGet = unapply(WeakMap.prototype.get);
const WeakMapHas = unapply(WeakMap.prototype.has);
const WeakMapSet = unapply(WeakMap.prototype.set);
const hasOwnProperty = unapply(Object.prototype.hasOwnProperty);
const map = unapply(Array.prototype.map);

export {
    ErrorCreate,
    ProxyRevocable,
    SetCreate,
    SetHas,
    WeakMapCreate,
    WeakMapGet,
    WeakMapHas,
    WeakMapSet,
    hasOwnProperty,
    map,
};

export function unapply(func: Function): Function {
    return (thisArg: any, ...args: any[]) => apply(func, thisArg, args);
}

export function unconstruct(func: Function): Function {
    return (...args: any[]) => construct(func, args);
}

export function isUndefined(obj: any): obj is undefined {
    return obj === undefined;
}

export function isNullish(obj: any): obj is null {
    // eslint-disable-next-line eqeqeq
    return obj == null;
}

export function isTrue(obj: any): obj is true {
    return obj === true;
}

export function isFunction(obj: any): obj is Function {
    return typeof obj === 'function';
}

export const emptyArray: [] = [];

export const ESGlobalKeys = SetCreate([

    // *** 18.1 Value Properties of the Global Object
    'Infinity',
    'NaN',
    'undefined',

    // *** 18.2 Function Properties of the Global Object
    'eval', // dangerous
    'isFinite',
    'isNaN',
    'parseFloat',
    'parseInt',
    'decodeURI',
    'decodeURIComponent',
    'encodeURI',
    'encodeURIComponent',

    // *** 18.3 Constructor Properties of the Global Object
    'Array',
    'ArrayBuffer',
    'Boolean',
    'DataView',
    'Date', // Unstable
    'Error', // Unstable
    'EvalError',
    'Float32Array',
    'Float64Array',
    'Function', // dangerous
    'Int8Array',
    'Int16Array',
    'Int32Array',
    'Map',
    'Number',
    'Object',
    'Promise', // Unstable
    'Proxy', // Unstable
    'RangeError',
    'ReferenceError',
    'RegExp', // Unstable
    'Set',
    'SharedArrayBuffer',
    'String',
    'Symbol',
    'SyntaxError',
    'TypeError',
    'Uint8Array',
    'Uint8ClampedArray',
    'Uint16Array',
    'Uint32Array',
    'URIError',
    'WeakMap',
    'WeakSet',

    // *** 18.4 Other Properties of the Global Object
    'Atomics',
    'JSON',
    'Math',
    'Reflect',

    // *** Annex B
    'escape',
    'unescape',

    // *** ECMA-402
    'Intl', // Unstable
]);

// These are intrinsics that can be reached by syntax, and must be mapped between realms.
// TODO: revisit this list.
// NOTE: intentionally ignoring EvalError and Error since they are not produced
//       by syntax anymore.
export function extractUndeniableIntrinsics(globalObj: typeof globalThis): any[] {
    return map(globalObj.eval(`[
        ({}),
        (_=>1),
        [],
        /x/,
        true,
        (1),
        "",
        (async aPromise=>1)(),
        (async anAsyncFunc=>1),
        (function* aGeneratorFunc(){}),
        (async function* anAsyncGeneratorFunc(){}),
        (()=>{try{decodeURIComponent('%')}catch(aURIError){return aURIError}})(),
        (()=>{try{null.f()}catch(aTypeError){return aTypeError}})(),
        (()=>{try{eval('return')}catch(aSyntaxError){return aSyntaxError}})(),
        (()=>{try{arguments}catch(aReferenceError){return aReferenceError}})(),
        (()=>{try{[].length=NaN}catch(aRangeError){return aRangeError}})(),
        new EvalError,
        new Error,
    ]`), (o: any) => o.__proto__);
}