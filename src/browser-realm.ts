import { SecureEnvironment } from "./environment";
import { SecureProxyTarget, RawFunction } from "./types";
import {
    ReflectGetPrototypeOf,
    ReflectSetPrototypeOf,
    getOwnPropertyDescriptors,
    construct,
    ErrorCreate,
} from "./shared";

// caching references to object values that can't be replaced
// window -> Window -> WindowProperties -> EventTarget
const rawWindow = globalThis.window;
const rawDocument = globalThis.document;
const rawWindowProto = ReflectGetPrototypeOf(rawWindow);
const rawWindowPropertiesProto = ReflectGetPrototypeOf(rawWindowProto);
const rawEventTargetProto = ReflectGetPrototypeOf(rawWindowPropertiesProto);

// A comprehensive list of policy feature directives can be found at
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Feature-Policy#Directives
// Directives not currently supported by Chrome are commented out because
// Chrome logs warnings to the developer console.
const IFRAME_ALLOW_ATTRIBUTE_VALUE =
    "accelerometer 'none';" +
    "ambient-light-sensor 'none';" +
    "autoplay 'none';" +
    // "battery 'none';" +
    "camera 'none';" +
    // "display-capture 'none';" +
    "document-domain 'none';" +
    "encrypted-media 'none';" +
    // "execution-while-not-rendered 'none';" +
    // "execution-while-out-of-viewport 'none';" +
    "fullscreen 'none';" +
    "geolocation 'none';" +
    "gyroscope 'none';" +
    // "layout-animations 'none';" +
    // "legacy-image-formats 'none';" +
    "magnetometer 'none';" +
    "microphone 'none';" +
    "midi 'none';" +
    // "navigation-override 'none';" +
    // "oversized-images 'none';" +
    "payment 'none';" +
    "picture-in-picture 'none';" +
    // "publickey-credentials 'none';" +
    "sync-xhr 'none';" +
    "usb 'none';" +
    // "wake-lock 'none';" +
    "xr-spatial-tracking 'none';"

const IFRAME_SANDBOX_ATTRIBUTE_VALUE = 'allow-same-origin allow-scripts';

export default function createSecureEnvironment(distortionMap?: Map<SecureProxyTarget, SecureProxyTarget>): (sourceText: string) => void {
    // @ts-ignore document global ref - in browsers
    const iframe = document.createElement('iframe');
    iframe.setAttribute('allow', IFRAME_ALLOW_ATTRIBUTE_VALUE);
    iframe.setAttribute('sandbox', IFRAME_SANDBOX_ATTRIBUTE_VALUE);
    iframe.style.display = 'none';

    // @ts-ignore document global ref - in browsers
    document.body.appendChild(iframe);

    // For Chrome we evaluate the `window` object to kickstart the realm so that
    // `window` persists when the iframe is removed from the document.
    const secureWindow = (iframe.contentWindow as WindowProxy).window;
    const { eval: secureIndirectEval } = secureWindow;
    secureIndirectEval('window');

    // In Chrome debugger statements will be ignored when the iframe is removed
    // from the document. Other browsers like Firefox and Safari work as expected.
    // https://bugs.chromium.org/p/chromium/issues/detail?id=1015462
    iframe.remove();

    // window -> Window -> WindowProperties -> EventTarget
    const secureDocument = secureWindow.document;
    const secureWindowProto = ReflectGetPrototypeOf(secureWindow);
    const secureWindowPropertiesProto = ReflectGetPrototypeOf(secureWindowProto);
    const secureEventTargetProto = ReflectGetPrototypeOf(secureWindowPropertiesProto);

    const rawDocumentProto = ReflectGetPrototypeOf(rawDocument);
    const rawGlobalThisDescriptors = getOwnPropertyDescriptors(rawWindow) as PropertyDescriptorMap;
    const rawWindowProtoDescriptors = getOwnPropertyDescriptors(rawWindowProto);
    const rawWindowPropertiesProtoDescriptors = getOwnPropertyDescriptors(rawWindowPropertiesProto);
    const rawEventTargetProtoDescriptors = getOwnPropertyDescriptors(rawEventTargetProto);

    // removing problematic descriptors that should never be installed
    delete rawGlobalThisDescriptors.location;
    delete rawGlobalThisDescriptors.EventTarget;
    delete rawGlobalThisDescriptors.document;
    delete rawGlobalThisDescriptors.window;

    // Some DOM APIs do brand checks for TypeArrays and others objects,
    // in this case, if the API is not dangerous, and works in a detached
    // iframe, we can let the sandbox to use the iframe's api directly,
    // instead of remapping it to the outer realm.
    // TODO [issue #67]: review this list
    delete rawGlobalThisDescriptors.crypto;

    const env = new SecureEnvironment({
        rawGlobalThis: rawWindow,
        secureGlobalThis: secureWindow,
        distortionMap,
    });

    // other maps
    env.remap(secureDocument, rawDocument, {/* it only has location, which is ignored for now */});
    ReflectSetPrototypeOf(secureDocument, env.getSecureValue(rawDocumentProto));

    // remapping window proto chain backward
    env.remap(secureEventTargetProto, rawEventTargetProto, rawEventTargetProtoDescriptors);
    env.remap(secureWindowPropertiesProto, rawWindowPropertiesProto, rawWindowPropertiesProtoDescriptors);
    env.remap(secureWindowProto, rawWindowProto, rawWindowProtoDescriptors);
    env.remap(secureWindow, rawWindow, rawGlobalThisDescriptors);

    // finally, we return the evaluator function
    return (sourceText: string): void => {
        try {
            secureIndirectEval(sourceText);
        } catch (e) {
            // This error occurred when the outer realm attempts to evaluate a
            // sourceText into the sandbox. By throwing a new raw error, which
            // eliminates the stack information from the sandbox as a consequence.
            let rawError;
            const { message } = e;
            try {
                const rawErrorProto = env.getRawRef(ReflectGetPrototypeOf(e));
                // the constructor must be registered (done during construction of env)
                // otherwise we need to fallback to a regular error.
                rawError = construct(rawErrorProto.constructor as RawFunction, [message]);
            } catch {
                // in case the constructor inference fails
                rawError = ErrorCreate(message);
            }
            throw rawError;
        }
    };
}
