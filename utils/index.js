const config = require("../config")
const _ = require("lodash")
const jskos = require("jskos-tools")
const { DuplicateEntityError, EntityNotFoundError, CreatorDoesNotMatchError } = require("../errors")

// Container needed to load services that load properties
const Container = require("typedi").Container// Services, keys are according to req.type
const services = {}
for (let type of ["schemes", "concepts", "concordances", "mappings", "annotations"]) {
  Object.defineProperty(services, type, {
    get() {
      return Container.get(require("../services/" + type))
    },
  })
}

/**
 * These are wrappers for Express middleware which receive a middleware function as a first parameter,
 * but wrap the call to the function with other functionality.
 */
const wrappers = {

  /**
   * Wraps an async middleware function that returns data in the Promise.
   * The result of the Promise will be written into req.data for access by following middlewaren.
   * A rejected Promise will be caught and relayed to the Express error handling.
   *
   * adjusted from: https://thecodebarbarian.com/80-20-guide-to-express-error-handling
   */
  async(fn) {
    return (req, res, next) => {
      fn(req, res, next).then(data => {
        // On success, save the result of the Promise in req.data.
        req.data = data
        next()
      }).catch(error => {
        // Catch and change certain errors
        if (error.code === 11000) {
          error = new DuplicateEntityError(null, _.get(error, "keyValue._id"))
        }
        // Pass error to the next error middleware.
        next(error)
      })
    }
  },

  // Middleware wrapper that calls the middleware depending on req.query.download
  download(fn, isDownload = true) {
    return (req, res, next) => {
      if (!!req.query.download === isDownload) {
        fn(req, res, next)
      } else {
        next()
      }
    }
  },

}

// Recursively remove all fields starting with _ from response
// Gets called in `returnJSON` and `handleDownload`. Shouldn't be used anywhere else.
const cleanJSON = (json) => {
  if (_.isArray(json)) {
    json.forEach(cleanJSON)
  } else if (_.isObject(json)) {
    _.forOwn(json, (value, key) => {
      if (key.startsWith("_")) {
        // remove from object
        _.unset(json, key)
      } else {
        cleanJSON(value)
      }
    })
  }
}

// Adjust data in req.data based on req.type (which is set by `addMiddlewareProperties`)
const adjust = async (req, res, next) => {
  /**
   * Skip adjustments if either:
   * - there is no data
   * - there is no data type (i.e. we don't know which adjustment method to use)
   * - the request was a bulk operation
   */
  if (!req.data || !req.type || req.query.bulk) {
    next()
  }
  let type = req.type
  // Remove "s" from the end of type if it's not an array
  if (!_.isArray(req.data)) {
    type = type.substring(0, type.length - 1)
  }
  if (adjust[type]) {
    req.data = await adjust[type](req.data, (_.get(req, "query.properties", "").split(",")))
  }
  next()
}

// Add @context and type to annotations.
adjust.annotation = (annotation) => {
  if (annotation) {
    annotation["@context"] = "http://www.w3.org/ns/anno.jsonld"
    annotation.type = "Annotation"
  }
  return annotation
}
adjust.annotations = annotations => {
  return annotations.map(annotation => adjust.annotation(annotation))
}

// Add @context and type to concepts. Also load properties narrower, ancestors, and annotations if necessary.
adjust.concept = async (concept, properties = []) => {
  if (concept) {
    concept["@context"] = "https://gbv.github.io/jskos/context.json"
    concept.type = concept.type || ["http://www.w3.org/2004/02/skos/core#Concept"]
    // Add properties (narrower, ancestors)
    for (let property of ["narrower", "ancestors"].filter(p => properties.includes(p))) {
      concept[property] = await Promise.all((await services.concepts[`get${property.charAt(0).toUpperCase() + property.slice(1)}`]({ uri: concept.uri })).map(concept => adjust.concept(concept)))
    }
    // Add properties (annotations)
    if (properties.includes("annotations") && concept.uri) {
      concept.annotations = (await services.annotations.getAnnotations({ target: concept.uri })).map(annotation => adjust.annotation(annotation))
    }
  }
  return concept
}
adjust.concepts = async (concepts, properties) => {
  return await Promise.all(concepts.map(concept => adjust.concept(concept, properties)))
}

// Add @context to concordances.
adjust.concordance = (concordance) => {
  if (concordance) {
    concordance["@context"] = "https://gbv.github.io/jskos/context.json"
  }
  return concordance
}
adjust.concordances = (concordances) => {
  return concordances.map(concordance => adjust.concordance(concordance))
}

// Add @context to mappings. Also load annotations if necessary.
adjust.mapping = async (mapping, properties = []) => {
  if (mapping) {
    mapping["@context"] = "https://gbv.github.io/jskos/context.json"
    // Add properties (annotations)
    if (properties.includes("annotations") && mapping.uri) {
      mapping.annotations = (await services.annotations.getAnnotations({ target: mapping.uri })).map(annotation => adjust.annotation(annotation))
    }
  }
  return mapping
}
adjust.mappings = async (mappings, properties) => {
  return await Promise.all(mappings.map(mapping => adjust.mapping(mapping, properties)))
}

// Add @context and type to schemes.
adjust.scheme = (scheme) => {
  if (scheme) {
    scheme["@context"] = "https://gbv.github.io/jskos/context.json"
    scheme.type = scheme.type || ["http://www.w3.org/2004/02/skos/core#ConceptScheme"]
  }
  return scheme
}
adjust.schemes = (schemes) => {
  return schemes.map(scheme => adjust.scheme(scheme))
}

/**
 * Returns a random v4 UUID.
 */
const uuid = require("uuid").v4

const uuidRegex = new RegExp(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i)
/**
 * Checks a v4 UUID for validity.
 *
 * @param {*} uuid
 */
const isValidUuid = (uuid) => {
  return uuid.match(uuidRegex) != null
}

const getUrisForUser = (user) => {
  if (!user) {
    return []
  }
  return [user.uri].concat(Object.values(user.identities || {}).map(identity => identity.uri)).filter(uri => uri != null)
}

/**
 * Returns `true` if the creator of `object` matches `user`, `false` if not.
 * `object.creator` can be
 * - an array of objects
 * - an object
 * - a string
 * The object for a creator will be checked for properties `uri` (e.g. JSKOS mapping) and `id` (e.g. annotations).
 *
 * If config.auth.allowCrossUserEditing is enabled, this returns true as long as a user and object are given.
 *
 * @param {object} user the user object (e.g. req.user)
 * @param {object} object any object that has the property `creator`
 * @param {string} type type of entity (e.g. `mappings`, `annotations`)
 * @param {string} action one of `read`/`create`/`update`/`delete`
 */
const matchesCreator = (user, object, type, action) => {
  let crossUser = false
  if (config[type] && config[type][action]) {
    crossUser = config[type][action].crossUser
  }
  // If config.auth.allowCrossUserEditing is enabled, return true
  if (crossUser) {
    return true
  }
  if (!object || !user) {
    return false
  }
  // If not, check URIs
  const userUris = getUrisForUser(user)
  // Support arrays, objects, and strings as creators
  let creators = _.isArray(object.creator) ? object.creator : (_.isObject(object.creator) ? [object.creator] : [{ uri: object.creator }])
  for (let creator of creators) {
    if (userUris.includes(creator.uri) || userUris.includes(creator.id)) {
      return true
    }
  }
  return false
}

/**
 * Middleware that adds default headers.
 */
const addDefaultHeaders = (req, res, next) => {
  if (req.headers.origin) {
    // Allow all origins by returning the request origin in the header
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin)
  } else {
    // Fallback to * if there is no origin in header
    res.setHeader("Access-Control-Allow-Origin", "*")
  }
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,PATCH,DELETE")
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, Link")
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  next()
}

/**
 * Middleware that adds default properties:
 *
 * - If req.query exists, make sure req.query.limit and req.query.offset are set as numbers.
 * - If possible, set req.type depending on the endpoint (one of concepts, schemes, mappings, annotations, suggest).
 */
const addMiddlewareProperties = (req, res, next) => {
  if (req.query) {
    // Limit for pagination
    const defaultLimit = 100
    req.query.limit = parseInt(req.query.limit)
    req.query.limit = req.query.limit || defaultLimit // Math.min(defaultLimit, req.query.limit || defaultLimit)
    // Offset for pagination
    const defaultOffset = 0
    req.query.offset = parseInt(req.query.offset)
    req.query.offset = req.query.offset || defaultOffset
    // Bulk option for POST endpoints
    req.query.bulk = req.query.bulk === "true" || req.query.bulk === "1"
  }
  // req.path -> req.type
  let type = req.path.substring(1)
  type = type.substring(0, type.indexOf("/") == -1 ? type.length : type.indexOf("/") )
  if (type == "voc") {
    if (req.path.includes("/top") || req.path.includes("/concepts")) {
      type = "concepts"
    } else {
      type = "schemes"
    }
  }
  if (type == "mappings") {
    if (req.path.includes("/suggest")) {
      type = "suggest"
    } else if (req.path.includes("/voc")) {
      type = "schemes"
    }
  }
  // TODO: /data can return schemes as well.
  if (["data", "narrower", "ancestors", "search"].includes(type)) {
    type = "concepts"
  }
  if (type == "suggest" && _.get(req, "query.format", "").toLowerCase() == "jskos") {
    type = "concepts"
  }
  req.type = type
  next()
}

/**
 * Middleware that receives a list of supported download formats and overrides req.query.download if the requested format is not supported.
 *
 * @param {Array} formats
 */
const supportDownloadFormats = (formats) => (req, res, next) => {
  if (req.query.download && !formats.includes(req.query.download)) {
    req.query.download = null
  }
  next()
}

/**
 * Sets pagination headers (X-Total-Count, Link) for a response.
 * See also: https://developer.github.com/v3/#pagination
 * For Link header rels:
 * - first and last are always set
 * - prev will be set if previous page exists (i.e. if offset > 0)
 * - next will be set if next page exists (i.e. if offset + limit < total)
 *
 * Requires req.data to be set.
 */
const addPaginationHeaders = (req, res, next) => {
  const limit = req.query.limit
  const offset = req.query.offset
  const total = _.get(req, "data.totalCount", req.data && req.data.length)
  if (req == null || res == null || limit == null || offset == null || total == null) {
    return
  }
  const baseUrl = config.baseUrl.substring(0, config.baseUrl.length - 1) + req.path
  const url = (query, rel) => {
    let url = baseUrl
    let index = 0
    _.forOwn(_.omit(query, ["bulk"]), (value, key) => {
      url += `${(index == 0 ? "?" : "&")}${key}=${encodeURIComponent(value)}`
      index += 1
    })
    return `<${url}>; rel="${rel}"`
  }
  // Set X-Total-Count header
  res.set("X-Total-Count", total)
  let links = []
  let query = _.cloneDeep(req.query)
  query.limit = limit
  // rel: first
  query.offset = 0
  links.push(url(query, "first"))
  // rel: prev
  if (offset > 0) {
    query.offset = Math.max(offset - limit, 0)
    links.push(url(query, "prev"))
  }
  // rel: next
  if (limit + offset < total) {
    query.offset = offset + limit
    links.push(url(query, "next"))
  }
  // rel: last
  let current = 0
  while (current + limit < total) {
    current += limit
  }
  query.offset = current
  links.push(url(query, "last"))
  // Set Link header
  res.set("Link", links.join(","))
  next()
}

/**
 * Middleware that returns JSON given in req.data.
 */
const returnJSON = (req, res) => {
  // Convert Mongoose documents into plain objects
  let data
  if (_.isArray(req.data)) {
    data = req.data.map(doc => doc.toObject ? doc.toObject() : doc)
    // Preserve totalCount
    data.totalCount = req.data.totalCount
  } else {
    data = req.data.toObject ? req.data.toObject() : req.data
  }
  cleanJSON(data)
  let statusCode = 200
  if (req.method == "POST") {
    statusCode = 201
  }
  res.status(statusCode).json(data)
}

const { Transform } = require("stream")
const JSONStream = require("JSONStream")
/**
 * Middleware that handles download streaming.
 * Requires a database cursor in req.data.
 *
 * @param {String} filename - resulting filename without extension
 */
const handleDownload = (filename) => (req, res) => {
  const results = req.data
  /**
   * Transformation object to remove _id parameter from objects in a stream.
   */
  const removeIdTransform = new Transform({
    objectMode: true,
    transform(chunk, encoding, callback) {
      cleanJSON(chunk)
      this.push(chunk)
      callback()
    },
  })
  // Default transformation: JSON
  let transform = JSONStream.stringify("[\n", ",\n", "\n]\n")
  let fileEnding = "json"
  let first = true, delimiter = ","
  let csv
  switch (req.query.download) {
    case "ndjson":
      fileEnding = "ndjson"
      res.set("Content-Type", "application/x-ndjson; charset=utf-8")
      transform = new Transform({
        objectMode: true,
        transform(chunk, encoding, callback) {
          this.push(JSON.stringify(chunk) + "\n")
          callback()
        },
      })
      break
    case "csv":
    case "tsv":
      fileEnding = req.query.download
      if (req.query.download == "csv") {
        delimiter = ","
        res.set("Content-Type", "text/csv; charset=utf-8")
      } else {
        delimiter = "\t"
        res.set("Content-Type", "text/tab-separated-values; charset=utf-8")
      }
      csv = jskos.mappingCSV({
        lineTerminator: "\r\n",
        creator: true,
        schemes: true,
        delimiter,
      })
      transform = new Transform({
        objectMode: true,
        transform(chunk, encoding, callback) {
        // Small workaround to prepend a line to CSV
          if (first) {
            this.push(`"fromScheme"${delimiter}"fromNotation"${delimiter}"toScheme"${delimiter}"toNotation"${delimiter}"toNotation2"${delimiter}"toNotation3"${delimiter}"toNotation4"${delimiter}"toNotation5"${delimiter}"type"${delimiter}"creator"\n`)
            first = false
          }
          this.push(csv.fromMapping(chunk, { fromCount: 1, toCount: 5 }))
          callback()
        },
      })
      break
  }
  // Add file header
  res.set("Content-disposition", `attachment; filename=${filename}.${fileEnding}`)
  // results is a database cursor
  results
    .pipe(removeIdTransform)
    .pipe(transform)
    .pipe(res)
}

/**
 * Extracts a creator objects from a request.
 *
 * @param {*} req request object
 */
const getCreator = (req) => {
  let creator = {}
  const creatorUriPath = req.type === "annotations" ? "id" : "uri"
  const creatorNamePath = req.type === "annotations" ? "name" : "prefLabel.en"
  const userUris = getUrisForUser(req.user)
  if (req.user && !userUris.includes(req.query.identity)) {
    _.set(creator, creatorUriPath, req.user.uri)
  } else if (req.query.identity) {
    _.set(creator, creatorUriPath, req.query.identity)
  }
  if (req.query.identityName) {
    _.set(creator, creatorNamePath, req.query.identityName)
  } else if (req.query.identityName !== "") {
    const name = _.get(Object.values(_.get(req, "user.identities", [])).find(i => i.uri === _.get(creator, creatorUriPath)) || req.user, "name")
    if (name) {
      _.set(creator, creatorNamePath, name)
    }
  }
  if (!_.get(creator, creatorUriPath) && !_.get(creator, creatorNamePath)) {
    creator = null
  }
  return creator
}

/**
 *
 * @param {Object} options.object JSKOS object
 * @param {Object} [options.existing] existing object from database for PUT/PATCH
 * @param {Object|Array} [options.creator] creator object or array, usually extracted via `getCreator` above
 * @param {Object} options.req request object (necessary for `type`, `user`, and `method`)
 */
const handleCreatorForObject = ({ object, existing, creator, req }) => {
  if (!object) {
    return object
  }
  // Remove `creator` and `contributor` from object
  delete object.creator
  delete object.contributor

  // JSKOS creator has to be an array
  if (creator && req.type !== "annotations") {
    creator = [creator]
  }

  const userUris = getUrisForUser(req.user)

  if (req.method === "POST") {
    if (creator) {
      object.creator = creator
    }
  } else if (req.method === "PUT" || req.method === "PATCH") {
    if (creator) {
      if (req.type === "annotations") {
        // No contributor for annotations
        object.creator = creator
      } else {
        // First, take existing creator and contributor
        object.creator = (existing && existing.creator) || []
        object.contributor = (existing && existing.contributor) || []
        // Look if current user is somewhere in either creator or contributor
        const creatorIndex = object.creator.findIndex(c => jskos.compare(c, { identifier: userUris }))
        const contributorIndex = object.contributor.findIndex(c => jskos.compare(c, { identifier: userUris }))
        if (creatorIndex === -1 && contributorIndex === -1) {
          // If the user is in neither, add as contributor and set creator if necessary
          if (object.creator.length == 0) {
            object.creator = creator
          }
          object.contributor.push(creator[0])
        } else {
          // Adjust creator if necessary
          if (creatorIndex !== -1) {
            object.creator[creatorIndex] = creator[0]
          }
          // Add user as contributor (to the end of array)
          if (contributorIndex !== -1) {
            object.contributor.splice(contributorIndex, 1)
            object.contributor.push(creator[0])
          } else {
            object.contributor.push(creator[0])
          }
        }
      }
    } else if (existing) {
      // If no creator is set, keep existing creator and contributor
      if (existing.creator) {
        object.creator = existing.creator
      }
      if (existing.contributor) {
        object.contributor = existing.contributor
      }
    }
  }

  return object
}

const anystream = require("json-anystream")
/**
 * Custom body parser middleware.
 * - For POSTs, adds body stream via json-anystream and adjusts objects via handleCreatorForObject.
 * - For PUT/PATCH/DELETE, parses JSON body, queries the existing entity which is saved in req.existing, checks creator, and adjusts object via handleCreatorForObject.
 *
 * @param {*} req
 * @param {*} res
 * @param {*} next
 */
const bodyParser = (req, res, next) => {

  // Assemble creator once
  const creator = getCreator(req)

  // Wrap handleCreatorForObject method
  const adjust = (object, existing) => {
    return handleCreatorForObject({
      object,
      existing,
      creator,
      req,
    })
  }

  if (req.method == "POST") {
    // For POST requests, parse body with json-anystream middleware
    anystream.addStream(adjust)(req, res, next)
  } else {
    // For all other requests, parse as JSON
    require("express").json()(req, res, (...params) => {
      // Get existing
      const uri = req.params._id || (req.body || {}).uri || req.query.uri
      services[req.type].get(uri)
        .catch(() => null)
        .then(existing => {
          if (!existing) {
            next(new EntityNotFoundError(null, uri))
          } else {
            const action = req.methd === "DELETE" ? "delete" : "update"
            if (!matchesCreator(req.user, existing, req.type, action)) {
              next(new CreatorDoesNotMatchError())
            } else {
              req.existing = existing
              req.body = adjust(req.body, existing)
              next(...params)
            }
          }
        })
    })
  }
}

/**
 * Determines whether a query is actually empty (i.e. returns all documents).
 *
 * @param {*} query
 */
const isQueryEmpty = (query) => {
  const allowedProps = ["$and", "$or"]
  let result = true
  _.forOwn(query, (value, key) => {
    if (!allowedProps.includes(key)) {
      result = false
    } else {
      // for $and and $or, value is an array
      _.forEach(value, (element) => {
        result = result && isQueryEmpty(element)
      })
    }
  })
  return result
}

/**
 * Returns the document count for a certain aggregation pipeline.
 * Uses estimatedDocumentCount() if possible (i.e. if the query is empty).
 *
 * @param {*} model a mongoose model
 * @param {*} pipeline an aggregation pipeline
 */
const count = async (model, pipeline) => {
  if (pipeline.length === 1 && pipeline[0].$match && isQueryEmpty(pipeline[0].$match)) {
    // It's an empty query, i.e. we can use estimatedDocumentCount()
    return await model.estimatedDocumentCount()
  } else {
    // Use aggregation instead
    return _.get(await model.aggregate(pipeline).count("count").exec(), "[0].count", 0)
  }
}

module.exports = {
  wrappers,
  cleanJSON,
  adjust,
  uuid,
  isValidUuid,
  matchesCreator,
  addDefaultHeaders,
  supportDownloadFormats,
  addMiddlewareProperties,
  addPaginationHeaders,
  returnJSON,
  handleDownload,
  bodyParser,
  searchHelper: require("./searchHelper"),
  getCreator,
  handleCreatorForObject,
  isQueryEmpty,
  count,
}
