import { SecureEnvironment } from "./environment";
import { SecureProxyTarget, RawFunction } from "./types";
import { getOwnPropertyDescriptors, construct, ErrorCreate, ReflectGetPrototypeOf } from "./shared";
import { runInNewContext } from 'vm';

// note: in a node module, the top-level 'this' is not the global object
// (it's *something* but we aren't sure what), however an indirect eval of
// 'this' will be the correct global object.
const unsafeGlobalEvalSrc = `(0, eval)("'use strict'; this")`;

export default function createSecureEnvironment(distortionMap?: Map<SecureProxyTarget, SecureProxyTarget>): (sourceText: string) => void {
    // Use unsafeGlobalEvalSrc to ensure we get the right 'this'.
    const secureGlobalThis = runInNewContext(unsafeGlobalEvalSrc);
    const { eval: secureIndirectEval } = secureGlobalThis;
    const rawGlobalThis = globalThis as any;
    const rawGlobalThisDescriptors = getOwnPropertyDescriptors(rawGlobalThis);
    const env = new SecureEnvironment({
        rawGlobalThis,
        secureGlobalThis,
        distortionMap,
    });

    // remapping globals
    env.remap(secureGlobalThis, rawGlobalThis, rawGlobalThisDescriptors);

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
                // the proto must be registered (done during construction of env)
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
