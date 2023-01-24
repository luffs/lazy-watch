import 'setimmediate'
export class LazyWatch {
  constructor (original) {
    let masterDiff = {}
    let diffEmitTimeout = 0
    const childProxyCache = new WeakMap()
    const proxy = new Proxy(original, getProxyHandler())

    const diffEmitter = () => {
      const listeners = LazyWatch.LISTENERS.get(proxy) || []
      listeners.forEach(listener => listener(masterDiff))
      masterDiff = {}
    }

    return proxy

    function getProxyHandler (path = []) {
      return {
        get (target, prop, receiver) {
          if (LazyWatch.RESOLVE_MODE) {
            return target
          } else if (isObject(target[prop])) {
            let child = childProxyCache.get(target[prop])
            if (!child) {
              child = new Proxy(target[prop], getProxyHandler([...path, prop]))
              childProxyCache.set(target[prop], child)
            }
            return child
          } else {
            return target[prop]
          }
        },
        set (target, prop, value, receiver) {
          // always update target prop, but only emit diff if json values have changed
          if (target[prop] !== value) {
            value = LazyWatch.resolveIfProxy(value)
            const diff = LazyWatch.getDiffObject(masterDiff, path)

            if (isObject(target[prop]) && isObject(value)) {
              const child = receiver[prop]
              LazyWatch.overwrite(child, value)
            } else {
              diff[prop] = deepClone(value)
              target[prop] = deepClone(value)
              clearImmediate(diffEmitTimeout)
              diffEmitTimeout = setImmediate(diffEmitter)
            }
          }
          return true
        },
        deleteProperty (target, prop) {
          if (target[prop] !== undefined) {
            const diff = LazyWatch.getDiffObject(masterDiff, path)
            diff[prop] = null
            delete target[prop]
            clearImmediate(diffEmitTimeout)
            diffEmitTimeout = setImmediate(diffEmitter)
          }
          return true
        }
      }
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
    const lengthModified = Array.isArray(target) && typeof source.length === 'number' && (target.length !== source.length)
    if (lengthModified) {
      target.length = source.length
    }

    for (const key in source) {
      if ({}.hasOwnProperty.call(source, key)) {
        const bothAreObjects = isObject(source[key]) && isObject(target[key])
        const isSame = target[key] === source[key]

        if (bothAreObjects) {
          // merge objects and arrays
          LazyWatch.overwrite(target[key], source[key])
        } else if (source[key] === null) {
          // remove key from target when value is null
          delete target[key]
          target.__ob__ && target.__ob__.dep.notify()
        } else if (!isSame) {
          if (Array.isArray(target)) {
            target.splice(key, 1, source[key])
          } else {
            target[key] = source[key]
            target.__ob__ && target.__ob__.dep.notify()
          }
        }
      }
    }

    const deleteMissingProperties = !LazyWatch.PATCH_MODE && !Array.isArray(target)
    if (deleteMissingProperties) {
      // delete keys from target that are not in source
      for (const key in target) {
        if ({}.hasOwnProperty.call(target, key) && source[key] === null) {
          delete target[key]
          target.__ob__ && target.__ob__.dep.notify()
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
    if (index) {
      listeners.slice(index, 1)
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

function isObject (val) {
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
