import { setImmediatePolyfill } from "./set-immediate.js";

const context = typeof self === 'undefined'
  ? (typeof global === 'undefined' ? this : global)
  : self
export const setImmediatePolyfillStatus = setImmediatePolyfill(context)

export class LazyWatch {
  constructor (original) {
    let masterDiff = {}
    const cache = new WeakMap()
    const proxy = createProxy(original)

    let diffEmitterTimeout = 0
    const diffEmitter = () => {
      const listeners = LazyWatch.LISTENERS.get(proxy) || []
      listeners.forEach(listener => listener(masterDiff))
      masterDiff = {}
    }

    return proxy

    function createProxy (obj, path = []) {
      return new Proxy(obj, {
        get (target, prop) {
          if (LazyWatch.RESOLVE_MODE) {
            // return the original object, without the proxy
            return target
          }
          if (typeof target[prop] === 'object' && target[prop] !== null) {
            // get proxy from cache, or add to cache and return from cache
            let childProxy = cache.get(target[prop])
            if (!childProxy) {
              childProxy = createProxy(target[prop], [...path, prop])
              cache.set(target[prop], childProxy)
            }
            return childProxy
          }
          return target[prop]
        },
        set (target, prop, value, receiver) {
          // adding a LazyWatch instance to another instance? resolve the original object
          value = LazyWatch.resolveIfProxy(value)

          const targetPropIsObject = typeof target[prop] === 'object' && target[prop]
          const valueIsObject = typeof value === 'object' && value

          if (Array.isArray(target[prop]) && Array.isArray(value)) {
            let currentArrayLength = target[prop].length

            // if array length has changed
            if (value.length !== currentArrayLength) {
              receiver[prop].length = value.length

              // clean the diff object from props higher than length
              const diff = LazyWatch.getDiffObject(masterDiff, [...path, prop])
              for (const key in diff) {
                if (key >= value.length) {
                  delete diff[key]
                }
              }
            }
          }

          if (targetPropIsObject && valueIsObject) {
            // merge if both are objects. use receiver[prop] so it will be a proxy instance
            const propValueProxy = receiver[prop]
            LazyWatch.overwrite(propValueProxy, value)
          } else if (target[prop] !== value) {
            const diff = LazyWatch.getDiffObject(masterDiff, path)

            // if array is cleared (length set to 0), but then has more items added to it
            if (typeof diff.length === 'number') {
              const index = parseInt(prop, 10)
              if (diff.length <= index) {
                diff.length = index + 1
              }
            }

            diff[prop] = deepClone(value)
            target[prop] = deepClone(value)

            context.clearImmediate(diffEmitterTimeout)
            diffEmitterTimeout = context.setImmediate(diffEmitter)
          }
          return true
        },
        deleteProperty (target, prop) {
          if (target[prop] !== undefined) {
            const diff = LazyWatch.getDiffObject(masterDiff, path)
            diff[prop] = null
            delete target[prop]
            context.clearImmediate(diffEmitterTimeout)
            diffEmitterTimeout = context.setImmediate(diffEmitter)
          }
          return true
        }
      })
    }
  }
  static getDiffObject (diffObj, path) {
    for (let i = 0; i < path.length; i++) {
      if (!diffObj[path[i]]) {
        diffObj[path[i]] = {}
      }
      diffObj = diffObj[path[i]]
    }
    return diffObj
  }

  static overwrite (target, source) {
    let modified = false
    for (const prop in source) {
      if (source[prop] === null) {
        // null values are treated as things that should be deleted
        delete target[prop]
        modified = true
      } else if (isObjectOrArray(target[prop]) && isObjectOrArray(source[prop])) {
        // merge if both are objects
        this.overwrite(target[prop], source[prop])
      } else {
        if (isObjectOrArray(source[prop])) {
          // null values are treated as things that should be deleted
          for (const key in source[prop]) {
            if (source[prop][key] === null) {
              delete source[prop][key]
            }
          }
        }
        target[prop] = source[prop]
        modified = true
      }
    }

    const deleteMissingProperties = !LazyWatch.PATCH_MODE && !Array.isArray(target)
    if (deleteMissingProperties) {
      // delete keys from target that are not in source
      for (const prop in target) {
        if (Object.hasOwnProperty.call(target, prop) && (source[prop] === null || source[prop] === undefined)) {
          delete target[prop]
          modified = true
        }
      }
    }
  }

  static patch (target, source) {
    LazyWatch.PATCH_MODE = true
    LazyWatch.overwrite(target, source)
    LazyWatch.PATCH_MODE = false
  }

  static on (instance, listener) {
    const listeners = LazyWatch.LISTENERS.get(instance) || []
    listeners.push(listener)
    LazyWatch.LISTENERS.set(instance, listeners)
  }

  static off (instance, listener) {
    const listeners = LazyWatch.LISTENERS.get(instance) || []
    const index = listeners.indexOf(listener)
    if (index !== -1) {
      listeners.splice(index, 1)
    }
    LazyWatch.LISTENERS.set(instance, listeners)
  }

  static resolveIfProxy (obj) {
    let target = obj
    if (obj && typeof obj === 'object') {
      LazyWatch.RESOLVE_MODE = true // Turn on our switch
      try {
        target = obj.someDummyPropThatDoesntExist // This gets the target not the prop!
      } catch (e) {
        console.error(e)
      }
      LazyWatch.RESOLVE_MODE = false // Turn off the switch for the getter to behave normally
    }
    return target || obj // Return what we got!
  }
}

LazyWatch.PATCH_MODE = false
LazyWatch.RESOLVE_MODE = false
LazyWatch.LISTENERS = new WeakMap()

function isObjectOrArray (val) {
  return val && typeof val === 'object' && !(val instanceof Date)
}

function deepClone (obj, hash = new WeakMap()) {
  if (Object(obj) !== obj) return obj // primitives
  if (hash.has(obj)) return hash.get(obj) // cyclic reference
  const result =
    obj instanceof Set
      ? new Set(obj) // objects contained in sets are NOT cloned
      : obj instanceof Map
        ? new Map(Array.from(obj, ([key, val]) => [key, deepClone(val, hash)]))
        : obj instanceof Date ? new Date(obj)
          : obj instanceof RegExp ? new RegExp(obj.source, obj.flags)
            // ... add here any specific treatment for other classes ...
            // and finally a catch-all:
            : obj.constructor ? new obj.constructor()
              : Object.create(null)

  hash.set(obj, result)
  return Object.assign(result, ...Object.keys(obj)
    .map(key => ({ [key]: deepClone(obj[key], hash) }))
  )
}
