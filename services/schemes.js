const _ = require("lodash")
const validate = require("jskos-validate")
const utils = require("../utils")

const { MalformedBodyError, MalformedRequestError, EntityNotFoundError, DatabaseAccessError, InvalidBodyError } = require("../errors")
const Scheme = require("../models/schemes")
const Concept = require("../models/concepts")

module.exports = class SchemeService {

  /**
   * Return a Promise with an array of vocabularies.
   */
  async getSchemes(query) {
    let mongoQuery = {}
    if (query.uri) {
      mongoQuery = {
        $or: query.uri.split("|").map(uri => ({ uri })).concat(query.uri.split("|").map(uri => ({ identifier: uri }))),
      }
    }
    if (query.type) {
      mongoQuery.type = query.type
    }
    if (query.languages) {
      mongoQuery.languages = {
        $in: query.languages.split(","),
      }
    }
    if (query.subject) {
      mongoQuery["subject.uri"] = {
        $in: query.subject.split("|"),
      }
    }
    if (query.license) {
      mongoQuery["license.uri"] = {
        $in: query.license.split("|"),
      }
    }
    if (query.partOf) {
      mongoQuery["partOf.uri"] = {
        $in: query.partOf.split("|"),
      }
    }
    if (query.publisher) {
      mongoQuery._keywordsPublisher = query.publisher
    }
    // Sort order (default: asc = 1)
    const order = query.order === "desc" ? -1 : 1
    const sort = {}
    switch (query.sort) {
      case "label":
        sort["_keywordsLabels.0"] = order
        break
      case "notation":
        sort["_keywordsNotation.0"] = order
        break
      case "created":
        sort["created"] = order
        break
      case "modified":
        sort["modified"] = order
        break
    }

    const schemes = await Scheme.find(mongoQuery).sort(sort).lean().skip(query.offset).limit(query.limit).exec()
    schemes.totalCount = await utils.count(Scheme, [{ $match: mongoQuery }])
    return schemes
  }

  async get(uri) {
    return this.getScheme(uri)
  }

  async getScheme(identifierOrNotation) {
    return await Scheme.findOne({ $or: [{ uri: identifierOrNotation }, { identifier: identifierOrNotation }, { notation: new RegExp(`^${identifierOrNotation}$`, "i") }]}).lean().exec()
  }

  /**
   * Return a Promise with suggestions, either in OpenSearch Suggest Format or JSKOS (?format=jskos).
   */
  async getSuggestions(query) {
    let search = query.search = query.search || ""
    let format = query.format || ""
    let results = await this.searchScheme(search, query.voc)
    if (format.toLowerCase() == "jskos") {
      // Return in JSKOS format
      return results.slice(query.offset, query.offset + query.limit)
    }
    return utils.searchHelper.toOpenSearchSuggestFormat({
      query,
      results,
    })
  }

  /**
   * Return a Promise with an array of suggestions in JSKOS format.
   */
  async search(query) {
    let search = query.query || query.search || ""
    let results = await this.searchScheme(search)
    const searchResults = results.slice(query.offset, query.offset + query.limit)
    searchResults.totalCount = results.length
    return searchResults
  }

  async searchScheme(search) {
    return utils.searchHelper.searchItem({
      search,
      queryFunction: (query) => {
        return Scheme.find(query).lean()
      },
    })
  }

  // Write endpoints start here

  async postScheme({ bodyStream, bulk = false }) {
    if (!bodyStream) {
      throw new MalformedBodyError()
    }

    let isMultiple = true

    // As a workaround, build body from bodyStream
    // TODO: Use actual stream
    let schemes = await new Promise((resolve) => {
      const body = []
      bodyStream.on("data", scheme => {
        body.push(scheme)
      })
      bodyStream.on("isSingleObject", () => {
        isMultiple = false
      })
      bodyStream.on("end", () => {
        resolve(body)
      })
    })

    let response

    // Prepare
    schemes = await Promise.all(schemes.map(scheme => {
      return this.prepareAndCheckSchemeForAction(scheme, "create")
        .catch(error => {
          // Ignore errors for bulk
          if (bulk) {
            return null
          }
          throw error
        })
    }))
    // Filter out null
    schemes = schemes.filter(s => s)

    if (bulk) {
      // Use bulkWrite for most efficiency
      schemes.length && await Scheme.bulkWrite(schemes.map(s => ({
        replaceOne: {
          filter: { _id: s._id },
          replacement: s,
          upsert: true,
        },
      })))
      schemes = await this.postAdjustmentsForScheme(schemes, bulk)
      response = schemes.map(s => ({ uri: s.uri }))
    } else {
      schemes = await Scheme.insertMany(schemes, { lean: true })
      response = await this.postAdjustmentsForScheme(schemes, bulk)
    }

    return isMultiple ? response : response[0]
  }

  async putScheme({ body, existing }) {
    let scheme = body

    // Prepare
    scheme = await this.prepareAndCheckSchemeForAction(scheme, "update")

    // Override _id, uri, and created properties
    scheme._id = existing._id
    scheme.uri = existing.uri
    scheme.created = existing.created

    // Write scheme to database
    const result = await Scheme.replaceOne({ _id: scheme.uri }, scheme)
    if (!result.ok) {
      throw new DatabaseAccessError()
    }
    if (!result.n) {
      throw new EntityNotFoundError()
    }

    scheme = (await this.postAdjustmentsForScheme([scheme]))[0]

    return scheme
  }

  async deleteScheme({ uri, existing }) {
    if (!uri) {
      throw new MalformedRequestError()
    }
    if (existing.concepts.length) {
      // Disallow deletion
      // ? Which error type?
      throw new MalformedRequestError(`Concept scheme ${uri} still has concepts in the database and therefore can't be deleted.`)
    }
    const result = await Scheme.deleteOne({ _id: existing._id })
    if (!result.ok) {
      throw new DatabaseAccessError()
    }
    if (!result.n) {
      throw new EntityNotFoundError()
    }
  }

  /**
   * Prepares and checks a concept scheme before inserting/updating:
   * - validates object, throws error if it doesn't (create/update)
   * - add `_id` property (create/update)
   * - check if it exists, throws error if it doesn't (delete)
   * - check if it has existing concepts in database, throws error if it has (delete)
   *
   * @param {Object} scheme concept scheme object
   * @param {string} action one of "create", "update", and "delete"
   * @returns {Object} prepared concept scheme
   */
  async prepareAndCheckSchemeForAction(scheme, action) {
    if (!_.isObject(scheme)) {
      throw new MalformedBodyError()
    }
    if (["create", "update"].includes(action)) {
      // Validate scheme
      if (!validate.scheme(scheme) || !scheme.uri) {
        throw new InvalidBodyError()
      }
      // Add _id
      scheme._id = scheme.uri
      // Add index keywords
      utils.searchHelper.addKeywords(scheme)
      // Remove created for update action
      if (action === "update") {
        delete scheme.created
      }
    }

    return scheme
  }

  /**
   * Post-adjustments for concept schemes:
   * - update `concepts` property
   * - update `topConcepts` property
   * - get updated concept scheme from database
   *
   * @param {[Object]} schemes array of concept schemes to be adjusted
   * @param {Boolean} bulk indicates whether the adjustments are performaned as part of a bulk operation
   * @returns {[Object]} array of adjusted concept schemes
   */
  async postAdjustmentsForScheme(schemes, bulk = false) {
    // First, set created field if necessary
    await Scheme.updateMany(
      {
        _id: { $in: schemes.map(s => s.uri) },
        $or: [
          { created: { $eq: null } }, { created: { $exists: false } },
        ],
      },
      {
        $set: {
          created: (new Date()).toISOString(),
        },
      },
    )
    const result = []
    for (let scheme of schemes) {
      const hasTopConcepts = !!(await Concept.findOne({ $or: [scheme.uri].concat(scheme.identifier || []).map(uri => ({ "topConceptOf.uri": uri })) }))
      const hasConcepts = hasTopConcepts || !!(await Concept.findOne({ $or: [scheme.uri].concat(scheme.identifier || []).map(uri => ({ "inScheme.uri": uri })) }))
      const update = {
        $set: {
          concepts: hasConcepts ? [null] : [],
          topConcepts: hasTopConcepts ? [null] : [],
          modified: (new Date()).toISOString(),
        },
      }
      if (bulk) {
        delete update.$set.modified
      }
      await Scheme.updateOne({ _id: scheme.uri }, update)
      result.push(await Scheme.findById(scheme.uri))
    }
    return result
  }

  async createIndexes() {
    const indexes = []
    indexes.push([{ uri: 1 }, {}])
    indexes.push([{ identifier: 1 }, {}])
    indexes.push([{ notation: 1 }, {}])
    indexes.push([{ created: 1 }, {}])
    indexes.push([{ modified: 1 }, {}])
    indexes.push([{ "subject.uri": 1 }, {}])
    indexes.push([{ "license.uri": 1 }, {}])
    indexes.push([{ "partOf.uri": 1 }, {}])
    indexes.push([{ _keywordsLabels: 1 }, {}])
    indexes.push([{ _keywordsPublisher: 1 }, {}])
    // Add additional index for first entry which is used for sorting
    indexes.push([{ "_keywordsLabels.0": 1 }, {}])
    indexes.push([
      {
        _keywordsNotation: "text",
        _keywordsLabels: "text",
        _keywordsOther: "text",
      },
      {
        name: "text",
        default_language: "german",
        weights: {
          _keywordsNotation: 10,
          _keywordsLabels: 6,
          _keywordsOther: 3,
        },
      },
    ])
    // Create collection if necessary
    try {
      await Scheme.createCollection()
    } catch (error) {
      // Ignore error
    }
    // Drop existing indexes
    await Scheme.collection.dropIndexes()
    for (let [index, options] of indexes) {
      await Scheme.collection.createIndex(index, options)
    }
  }

}
