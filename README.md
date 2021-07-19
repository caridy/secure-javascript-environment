# JavaScript Near Membrane Library

This library implements a "near membrane" that can connect two Realms (the Incubator Realm, and the Child Realm) running on the same process. As a result, the Child Realm will emulate the capabilities of the Incubator Realm, plus the distortions defined as part of the near membrane configuration. Code evaluated inside the Child Realm will function as if it is evaluated in the Incubator Realm, exhibiting identity continuity, while preserving the integrity of the Incubator Realm by limiting the side effects that such code can have.

## Goals

* Code executed inside the sandboxed environment cannot observe the sandbox.
* Mutations on the object graph should only affect the sandboxed environment.

## Non-goals

* This library does not provide security guarantees, those must be implemented on top of the distortion mechanism.

## Terminology

In order to make it easier to explain how this library works, we use a color code to identify objects and values in general from both sides of the sandbox:

* Blue Realm is the Incubator Realm.
* Red Realm is the Child Realm that is sandboxed by this library.
* Blue Object, Blue Array, Blue Function, and Blue Values denote values that belong to the Blue Realm.
* Red Object, Red Array, Red Function, and Red Values denote values that belong to the Red Realm.
* Blue Proxy denote a Proxy created in the Blue Realm with a target that belongs to the Red Value.
* Red Proxy denotes a proxy created in the Red Realm with a target being a Blue Value.

## Design

This library implements a near membrane to sandbox a JavaScript environment object graph. This membrane is responsible for connecting the Blue Realm with a Red Realm, and it does that by remapping global references in the Red Realm to be Red Proxies (proxies of Blue Values).

This membrane modulates the communication between the two sides, specifically by creating proxies around objects, arrays and functions, while letting other primitives values travel safely throughout the membrane.

### Cross-sandbox communication

Since you can have multiple sandboxes associated to the Blue Realm, there is a possibility that they communicate with each other. This communication relies on the marshaling principle to avoid wrapping proxies over proxies when values are bounced between sandboxes via the Blue Realm. It does that by preserving the identity of the Blue Proxies observed by the Blue Realm. The Blue Realm is in control at all times, and the only way to communicate between sandboxes is to go through the Blue Realm.

## Implementation Details

### Implementation in Browsers

In browsers, since we don't have a way to create a light-weight Realm that is synchronously accessible (that will be solved in part by the [stage 2 Realms Proposal](https://github.com/tc39/proposal-realms)), we are forced to use a same-domain iframe in order to isolate the code to be evaluated inside a sandbox for a particular window.

#### Detached iframes

Since the iframes have many ways to reach out to the opener/top window reference, we are forced to use a detached `iframe`, which is, on itself, a complication. A detached `iframe`'s window is a window that does not have any host behavior associated to it, in other words, this window does not have an origin after disconnecting the iframe, which means it can't execute any DOM API without throwing a error. Luckly for us, the JavaScript intrinsics, and all JavaScript language features specified by Ecma262 and Ecma402 are still alive and kicking in that iframe, except for one feature, dynamic imports in a form of `import(specifier)`.

To mitigate the issue with dynamic imports, we are forced to transpile the code that attempts to use this feature of the language, otherwise it will just fail to fetch the module because there is no origin available at the host level. Luckly for us, transpiling dynamic imports is a very common way to bundle code for production systems today.

#### Unforgeables

The `window` reference in the detached iframe, just like any other `window` reference in browsers, contains various unforgeable descriptors, these are descriptors installed in Window, and other globals that are non-configurable, and therefor this library cannot remove them or replace them with a Red Proxy. Must notable, we have the window's prototype chain that is completely unforgeable:

```
window -> Window.prototype -> WindowProperties.prototype -> EventTarget.prototype
```

What we do in this case is to keep the identity of those unforgeable around, but changing the descriptors installing on them, and any other method that expects these identities to be passed to them. This make them effectively harmless because they don't give any power.

Additionally, there are other unforgeables like `location` that are host bounded, in that case, we don't have to do much since the detaching mechanism will automatically invalidate them.

These can only be virtualized via transpilation if they need to be available inside the sandbox. Such transpilation process is not provided as part of this library.

#### Requirements

The only requirement for the in-browser sandboxing mechanism described above is the usage of `eval` as the main mechanism for evaluating code inside the sandbox. This means your CSP rules should include at least `script-src: 'unsafe-eval'` in order for this library to function.

## Performance

Even though this library is still experimental, we want to showcase that it is possible to have a membrane that is fairly fast. The main feature of this library is the laziness aspect of the Red Proxies. Those proxies are only going to be initialized when one of the proxy's traps is invoked the first time. This allow us to have a sandbox creation process that is extremely fast.

Additionally, since existing host JavaScript environments are immense due to the amount of APIs that they offer, most programs will only need a very small subset of those APIs, and this library only activates the portions of the object graph that are observed by the executed code, making it really light weight compared to other implementations.

Finally, Blue Proxies are not lazy, they are initialized the first time they go through the membrane even if they are not used by the Blue Realm. This could be changed in the future if it becomes a bottleneck. For now, since this is a less common case, it seems to be fine.

## Where can I use this library?

We do not know the applications of this library just yet, but we suspect that there are many scenarios where it can be useful. Here are some that we have identified:

* Sandbox code to preserve the integrity of the app creating the sandbox, all code inside the sandbox will not observe that it is being sandboxed, but will not cause any integrity change that can cause the app's code to malfunction.
* Sandbox for polyfills: if you need to evaluate code that requires different set of polyfills and environment configuration, you could sandbox it without distortions.
* Limiting capabilities: if you need to evaluate code that should not have access to certain capabilities (global objects, getter, setters, etc.) you could sandbox it with a set of distortions to accommodate such limitations.
* Time-sensitive: If you need to evaluate code that should not observe time or should simulate a different time-frame, you should sandbox it with a set of distortions that can adjust the timers.

## The Code

* This library is distributed via npm packages `@locker/near-membrane-base`, `@locker/near-membrane-dom` and `@locker/near-membrane-node`.
* This library is implemented using TypeScript, and produces the proper TypeScript types, in case you care about it.
* Few tests are provided as of now, but the plan is to rely on existing tests (e.g.: WPT or ecma262) to validate that the near membrane created by this library is a high-fidelity membrane.
* The `src/` folder contains the library code, while the `lib/` folder will contain the compiled distributable code produced by executing the `build` script from `package.json`.
* This library does not have any runtime dependency, in fact it is very tiny.

## Challenges

### Debuggability

* Debugging is still very challenging considering that dev-tools are still catching up with the Proxies. Chrome for example has differences displaying proxies in the console vs the watch panel.

Additionally, there is an existing bug in ChromeDev-tools that prevent a detached iframe to be debugged (https://bugs.chromium.org/p/chromium/issues/detail?id=1015462).

### WindowProxy

The `window` reference in the iframe, just like any other `window` reference in browsers, exhibit a bizarre behavior, the `WindowProxy` behavior. This has two big implications for this implementation when attempting to give access to other window references coming from same domain iframes (e.g.: sandboxing the main app + one iframe):

* each window will require a new detached iframe to sandbox each of them, but if the iframe navigates to another page, the window reference remains the same, but the internal of the non-observable real window are changing. Otherwise distortions defined for the sandbox will not apply to the identity of the methods from the same-domain iframe.
* GCing the sandbox when the iframe navigates out is tricky due to the fact that the original iframe's window reference remains the same, and it is used by few of the internal maps.

For those reasons, we do not support accessing other realm instances from within the sandbox at the moment.

## Browsers Support and Stats

* Modern browsers with support for ES6 Proxy and WeakMaps.
* This library: ~3kb minified/gzip for browsers, ~2kb for node (no external dependencies).
