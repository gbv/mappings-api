const config = require("../config")
const utils = require("../utils")
const _ = require("lodash")
const validate = require("jskos-validate")

const Annotation = require("../models/annotations")
const { EntityNotFoundError, DatabaseAccessError, InvalidBodyError, MalformedBodyError, MalformedRequestError, ForbiddenAccessError } = require("../errors")

module.exports = class MappingService {

  /**
   * Returns a Promise with an array of annotations.
   *
   * TODO: Add sorting.
   */
  async getAnnotations(query) {
    let criteria = []
    if (query.id) {
      criteria.push({
        $or: [
          {
            _id: query.id,
          },
          {
            id: query.id,
          },
        ],
      })
    }
    if (query.creator) {
      criteria.push({
        $or: [
          {
            creator: query.creator,
          },
          {
            "creator.id": query.creator,
          },
          {
            "creator.name": query.creator,
          },
        ],
      })
    }
    if (query.target) {
      criteria.push({
        target: query.target,
      })
    }
    if (query.bodyValue) {
      criteria.push({
        bodyValue: query.bodyValue,
      })
    }
    if (query.motivation) {
      criteria.push({
        motivation: query.motivation,
      })
    }

    const mongoQuery = criteria.length ? { $and: criteria } : {}
    const annotations = await Annotation.find(mongoQuery).lean().skip(query.offset).limit(query.limit).exec()
    annotations.totalCount = await utils.count(Annotation, [{ $match: mongoQuery }])
    return annotations

  }

  async get(_id) {
    return this.getAnnotation(_id)
  }

  /**
   * Returns a promise with a single annotation with id in req.params._id.
   */
  async getAnnotation(_id) {
    if (!_id) {
      throw new MalformedRequestError()
    }
    const result = await Annotation.findById(_id).lean()
    if (!result) {
      throw new EntityNotFoundError(null, _id)
    }
    return result
  }

  /**
   * Save a new annotation or multiple annotations in the database. Adds created date if necessary.
   */
  async postAnnotation({ bodyStream, user, bulk = false, admin = false }) {
    if (!bodyStream) {
      throw new MalformedBodyError()
    }

    let isMultiple = true

    // As a workaround, build body from bodyStream
    // TODO: Use actual stream
    let annotations = await new Promise((resolve) => {
      const body = []
      bodyStream.on("data", annotation => {
        body.push(annotation)
      })
      bodyStream.on("isSingleObject", () => {
        isMultiple = false
      })
      bodyStream.on("end", () => {
        resolve(body)
      })
    })

    let response

    // Adjust all mappings
    annotations = annotations.map(annotation => {
      try {
        // For type moderating, check if user is on the whitelist (except for admin=true).
        if (!admin && annotation.motivation == "moderating") {
          let uris = [user.uri].concat(Object.values(user.identities || {}).map(id => id.uri)).filter(uri => uri != null)
          let whitelist = config.annotations.moderatingIdentities
          if (whitelist && _.intersection(whitelist, uris).length == 0) {
            // Disallow
            throw new ForbiddenAccessError("Access forbidden, user is not allowed to create annotations of type \"moderating\".")
          }
        }
        // Add created and modified dates.
        let date = (new Date()).toISOString()
        if (!annotation.created) {
          annotation.created = date
        }
        // Remove type property
        _.unset(annotation, "type")
        // Validate mapping
        if (!validate.annotation(annotation)) {
          throw new InvalidBodyError()
        }
        // Add _id and URI
        delete annotation._id
        let uriBase = config.baseUrl + "annotations/"
        if (annotation.id) {
          let id = annotation.id
          // ID already exists, use if it's valid, otherwise remove
          if (id.startsWith(uriBase) && utils.isValidUuid(id.slice(uriBase.length, id.length))) {
            annotation._id = id.slice(uriBase.length, id.length)
          }
        }
        if (!annotation._id) {
          annotation._id = utils.uuid()
          annotation.id = config.baseUrl + "annotations/" + annotation._id
        }
        // Make sure URI is a https URI when in production
        if (config.env === "production") {
          annotation.id = annotation.id.replace("http:", "https:")
        }

        return annotation
      } catch(error) {
        if (bulk) {
          return null
        }
        throw error
      }
    })
    annotations = annotations.filter(a => a)

    if (bulk) {
      // Use bulkWrite for most efficiency
      annotations.length && await Annotation.bulkWrite(annotations.map(a => ({
        replaceOne: {
          filter: { _id: a._id },
          replacement: a,
          upsert: true,
        },
      })))
      response = annotations.map(a => ({ id: a.id }))
    } else {
      response = await Annotation.insertMany(annotations, { lean: true })
    }

    return isMultiple ? response : response[0]
  }

  async putAnnotation({ body, existing }) {
    let annotation = body
    if (!annotation) {
      throw new InvalidBodyError()
    }
    // Add modified date.
    annotation.modified = (new Date()).toISOString()
    // Remove type property
    _.unset(annotation, "type")
    // Validate mapping
    if (!validate.annotation(annotation)) {
      throw new InvalidBodyError()
    }

    // Always preserve certain existing properties
    annotation.created = existing.created

    // Override _id and id properties
    annotation.id = existing.id
    annotation._id = existing._id

    const result = await Annotation.replaceOne({ _id: existing._id }, annotation)
    if (result.n && result.ok) {
      return annotation
    } else {
      throw new DatabaseAccessError()
    }
  }

  async patchAnnotation({ body, existing }) {
    let annotation = body
    if (!annotation) {
      throw new InvalidBodyError()
    }
    // Add modified date.
    annotation.modified = (new Date()).toISOString()
    // Remove creator, type, created
    _.unset(annotation, "creator")
    _.unset(annotation, "created")
    _.unset(annotation, "type")
    _.unset(annotation, "_id")
    _.unset(annotation, "id")
    // Use lodash merge to merge annotations
    _.merge(existing, annotation)
    // Validate mapping
    if (!validate.annotation(annotation)) {
      throw new InvalidBodyError()
    }

    const result = await Annotation.replaceOne({ _id: existing._id }, existing)
    if (result.ok) {
      return existing
    } else {
      throw new DatabaseAccessError()
    }
  }

  async deleteAnnotation({ existing }) {
    const result = await Annotation.deleteOne({ _id: existing._id })
    if (result.n && result.ok && result.deletedCount) {
      return
    } else {
      throw new DatabaseAccessError()
    }
  }

  async createIndexes() {
    const indexes = [
      [{ id: 1 }, {}],
      [{ target: 1 }, {}],
      [{ creator: 1 }, {}],
      [{ "creator.id": 1 }, {}],
      [{ "creator.name": 1 }, {}],
    ]
    // Create collection if necessary
    try {
      await Annotation.createCollection()
    } catch (error) {
      // Ignore error
    }
    // Drop existing indexes
    await Annotation.collection.dropIndexes()
    for (let [index, options] of indexes) {
      await Annotation.collection.createIndex(index, options)
    }
  }

}
