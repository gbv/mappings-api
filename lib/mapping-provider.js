const _ = require("lodash")
const jskos = require("jskos-tools")
const util = require("./util")
const escapeStringRegexp = require("escape-string-regexp")

/**
 * Provide Mappings stored in a MongoDB collection.
 */
class MappingProvider {

  constructor(collection, concordanceCollection) {
    this.collection = collection
    this.concordanceCollection = concordanceCollection
  }

  /**
   * Return a Promise with an array of concordances.
   */
  getConcordances(req, res) {
    let query = req.query
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    let conditions = []
    // Search by URI
    if (query.uri) {
      conditions.push({ $or: query.uri.split("|").map(uri => ({ "uri": uri })) })
    }
    // Search by fromScheme (URI or notation)
    if (query.fromScheme) {
      conditions.push({ $or: [
        { $or: query.fromScheme.split("|").map(fromScheme => ({ "fromScheme.uri": fromScheme })) },
        { $or: query.fromScheme.split("|").map(fromScheme => ({ "fromScheme.notation": fromScheme })) },
      ] })
    }
    // Search by toScheme (URI or notation)
    if (query.toScheme) {
      conditions.push({ $or: [
        { $or: query.toScheme.split("|").map(toScheme => ({ "toScheme.uri": toScheme })) },
        { $or: query.toScheme.split("|").map(toScheme => ({ "toScheme.notation": toScheme })) }
      ] })
    }
    // Search by creator
    if (query.creator) {
      let or = []
      for (let creator of query.creator.split("|")) {
        or.push({ "creator.prefLabel.de": creator })
        or.push({ "creator.prefLabel.en": creator })
      }
      if (or.length) {
        conditions.push({ $or: or })
      }
    }
    // Set mode
    let mode = query.mode
    if (!["and", "or"].includes(mode)) {
      mode = "and"
    }
    let cursor =  this.concordanceCollection.find(conditions.length ? { [`$${mode}`]: conditions } : {})
    return cursor.count().then(total => {
      if (query.download) {
        // For a download, just return the cursor.
        return cursor
      } else {
        // Add headers
        util.setPaginationHeaders({ req, res, limit, offset, total })
        return cursor.skip(offset).limit(limit).toArray()
      }
    })
  }

  /**
   * Return a Promise with an array of mappings.
   */
  getMappings(req, res) {
    let query = req.query
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    let direction = query.direction || "forward"
    let count = 0
    let fromTo = fromTo => {
      let result
      if (count == 1) {
        result = fromTo == "from" && direction == "backward" || fromTo == "to" && direction != "backward" ? "to" : "from"
      } else if (count <= 0) {
        return null
      } else {
        result = fromTo == "from" ? "to" : "from"
      }
      count -= 1
      return result
    }
    // Converts value to regex object for MongoDB if it ends with `*`.
    // Currently only supports truncated search like that, no arbitrary regex possible.
    const regex = value => {
      if (value.endsWith("*")) {
        return { $regex: `^${escapeStringRegexp(value.substring(0, value.length - 1))}` }
      } else {
        return value
      }
    }
    var criteria = ["from", "to"].filter(uri => query[uri]).map(part => {
      count = direction == "both" ? 2 : 1
      let or = []
      while (count > 0) {
        let set = {}, choice = {}
        let side = fromTo(part)
        if (query[part].startsWith("http")) {
          set[`${side}.memberSet.uri`] = regex(decodeURIComponent(query[part]))
          choice[`${side}.memberChoice.uri`] = regex(decodeURIComponent(query[part]))
        } else {
          set[`${side}.memberSet.notation`] = regex(decodeURIComponent(query[part]))
          choice[`${side}.memberChoice.notation`] = regex(decodeURIComponent(query[part]))
        }
        or.push(set, choice)
      }
      return { $or: or }
    })
    if (query.identifier) {
      // Add identifier to criteria
      criteria.push({ $or: query.identifier.split("|").map(id => ({ "identifier": id })) })
    }
    // Note: This should only be applied to "from" and "to", not to future parameters like "fromScheme" or "toScheme".
    let mode = query.mode
    if (!["and", "or"].includes(mode)) {
      mode = "and"
    }
    let mongoQuery1 = criteria.length ? { [`$${mode}`]: criteria } : {}
    // fromScheme / toScheme
    criteria = ["from", "to"].filter(uri => query[uri + "Scheme"]).map(part => {
      // reset count
      count = direction == "both" ? 2 : 1
      let or = []
      while (count > 0) {
        let scheme = {}
        if (query[part + "Scheme"].startsWith("http")) {
          scheme[`${fromTo(part)}Scheme.uri`] = decodeURIComponent(query[part + "Scheme"])
        } else {
          scheme[`${fromTo(part)}Scheme.notation`] = decodeURIComponent(query[part + "Scheme"])
        }
        or.push(scheme)
      }
      return { $or: or }
    })
    let mongoQuery2 = criteria.length ? { $and: criteria } : {}

    // Type
    let mongoQuery3 = {}
    if (query.type) {
      // FIXME: Replace with default type from jskos-tools (does not exist yet).
      if (query.type == "http://www.w3.org/2004/02/skos/core#mappingRelation") {
        mongoQuery3 = {
          $or: [
            {
              type: query.type
            },
            {
              type: { $exists: false }
            }
          ]
        }
      } else {
        mongoQuery3 = {
          type: query.type
        }
      }
    }

    // Concordances
    let mongoQuery4 = {}
    if (query.partOf) {
      let uris = query.partOf.split("|")
      mongoQuery4 = {
        $or: uris.map(uri => ({ "partOf.uri": uri }))
      }
    }

    // Concordances
    let mongoQuery5 = {}
    if (query.creator) {
      let creators = query.creator.split("|")
      mongoQuery4 = {
        $or: creators.map(creator => ({ "creator.prefLabel.de": creator }))
      }
    }

    let cursor =  this.collection.find({ $and: [mongoQuery1, mongoQuery2, mongoQuery3, mongoQuery4, mongoQuery5] })
    return cursor.count().then(total => {
      if (query.download) {
        // For a download, just return the cursor.
        return cursor
      } else {
        // Add headers
        util.setPaginationHeaders({ req, res, limit, offset, total })
        return cursor.skip(offset).limit(limit).toArray()
      }
    })
  }

  /**
   * Save a single mapping in the database. Adds created/modified dates, validates tge mapping, and adds identifiers.
   *
   * Experimental!
   */
  saveMapping(req) {
    let mapping = req.body.mapping
    if (!mapping) {
      return Promise.resolve(null)
    }
    // Add created and modified dates.
    let date = (new Date()).toISOString()
    if (!mapping.created) {
      mapping.created = date
    }
    mapping.modified = date
    // Validate mapping
    let valid = jskos.validate.mapping(mapping)
    if (!valid) {
      return Promise.resolve(null)
    }
    // Set confirmed property. TODO: Is this okay?
    mapping.confirmed = false
    // Add mapping identifier
    mapping = jskos.addMappingIdentifiers(mapping)
    // Save mapping
    return this.collection.insertOne(mapping)
      .then(() => {
        return mapping
      })
      .catch(error => {
        console.log(error)
        return null
      })
  }

  /**
   * Returns a promise with an array of concept schemes.
   */
  getMappingSchemes(req, res) {
    let query = req.query
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    // TODO: Optimize MongoDB queries
    let match = []
    if (query.from) {
      match.push({
        $or: [{
          "from.memberSet.uri": query.from
        }, {
          "from.memberSet.notation": query.from
        }]
      })
    }
    if (query.to) {
      match.push({
        $or: [{
          "to.memberSet.uri": query.to
        }, {
          "to.memberSet.notation": query.to
        },{
          "to.memberChoice.uri": query.to
        }, {
          "to.memberChoice.notation": query.to
        }]
      })
    }
    if (!match.length) {
      match = [{}]
    }
    let mode = query.mode
    if (!["and", "or"].includes(mode)) {
      // default: $or
      mode = "or"
    }
    match = { $match: { [`$${mode}`]: match } }
    let promises = [
      this.collection.aggregate([
        match,
        {
          $group: {
            _id: "$fromScheme",
            "count": { "$sum": 1 }
          }
        }
      ]).toArray(),
      this.collection.aggregate([
        match,
        {
          $group: {
            _id: "$toScheme",
            "count": { "$sum": 1 }
          }
        }
      ]).toArray()
    ]
    let schemes = {}
    return Promise.all(promises).then(results => {
      for (let result of results[0]) {
        // fromScheme counts
        schemes[result._id.uri] = result._id
        schemes[result._id.uri].fromCount = parseInt(result.count) || 0
      }
      for (let result of results[1]) {
        // toScheme counts
        schemes[result._id.uri] = schemes[result._id.uri] || result._id
        schemes[result._id.uri].toCount = parseInt(result.count) || 0
      }
      // Add headers
      util.setPaginationHeaders({ req, res, limit, offset, total: Object.values(schemes).length })
      return Object.values(schemes).slice(offset, offset+limit)
    })
  }

  /**
   * Returns a promise with suggestions in OpenSearch Suggest Format
   */
  getNotationSuggestions(req, res) {
    let query = req.query
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    let search = query.search
    if (!search || search.length == 0) {
      return Promise.resolve(["", [], [], []])
    }
    let vocs = query.voc && query.voc.split("|")
    let mongoQuery, and = [], or = []
    // Scheme restrictions
    // FIXME: Currently, this allows the scheme to be anywhere in the mapping.
    // Restrict it to the side where the notation is searched.
    if (vocs && vocs.length) {
      let vocOr = []
      for (let voc of vocs) {
        vocOr.push({ "fromScheme.uri": voc })
        vocOr.push({ "fromScheme.notation": voc })
        vocOr.push({ "toScheme.uri": voc })
        vocOr.push({ "toScheme.notation": voc })
      }
      and.push({ $or: vocOr })
    }
    // Notations
    // TODO: - Implement mode.
    let paths = ["from.memberSet", "to.memberSet", "to.memberList", "to.memberChoice"]
    for (let path of paths) {
      or.push({ [path + ".notation"]: { $regex: `^${search}` } })
    }
    and.push({ $or: or })
    mongoQuery = { $and: and }
    return this.collection.find(mongoQuery).toArray().then(mappings => {
      let results = []
      let descriptions = []
      for (let mapping of mappings) {
        for (let path of paths) {
          let concepts = _.get(mapping, path, null)
          if (!concepts) continue
          let notations = []
          for (let concept of concepts) {
            notations = notations.concat(concept.notation)
          }
          for (let notation of notations) {
            if (_.lowerCase(notation).startsWith(_.lowerCase(search))) {
              let index = results.indexOf(notation)
              if (index == -1) {
                results.push(notation)
                descriptions.push(1)
              } else {
                descriptions[index] += 1
              }
            }
          }
        }
      }
      let zippedResults = _.zip(results, descriptions)
      zippedResults.sort((a, b) => {
        return b[1] - a[1] || a[0] > b[0]
      })
      // Add headers
      util.setPaginationHeaders({ req, res, limit, offset, total: zippedResults.length })
      let unzippedResults = _.unzip(zippedResults.slice(offset, offset+limit))
      return [
        search,
        unzippedResults[0] || [],
        unzippedResults[1] || [],
        []
      ]
    })
  }
}

module.exports = MappingProvider
