const util = require("./util")
const _ = require("lodash")

/**
 * Provide terminologies and concepts stored in a MongoDB collection.
 *
 * TODO:
 * - Improve code documentation.
 * - Add support for "properties" parameter.
 */
class TerminologyProvider {

  constructor(terminologyCollection, conceptCollection) {
    this.terminologyCollection = terminologyCollection
    this.conceptCollection = conceptCollection
  }

  /**
   * Return a Promise with an array of vocabularies.
   */
  getVocabularies(req, res) {
    let query = req.query
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    let mongoQuery = {}
    if (query.uri) {
      mongoQuery = {
        $or: query.uri.split("|").map(uri => ({ uri }))
      }
    }
    let cursor = this.terminologyCollection.find(mongoQuery)
    return cursor.count().then(total => {
      // Add headers
      util.setPaginationHeaders({ req, res, limit, offset, total })
      return cursor.skip(offset).limit(limit).toArray()
    })
  }

  /**
   * Return a Promise with an array of concept data.
   */
  getDetails(req, res) {
    let query = req.query
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    if (!query.uri) {
      // Add headers
      util.setPaginationHeaders({ req, res, limit, offset, total: 0 })
      return Promise.resolve([])
    }
    let mongoQuery = {
      $or: query.uri.split("|").map(uri => ({ uri }))
    }
    // Return results for both concepts and terminologies
    let cursor1 = this.conceptCollection.find(mongoQuery)
    let cursor2 = this.terminologyCollection.find(mongoQuery)
    return Promise.all([cursor1.count(), cursor2.count()]).then(totals => {
      let total = totals.reduce((t, c) => t + c)
      // Add headers
      util.setPaginationHeaders({ req, res, limit, offset, total })
      return Promise.all([cursor1.skip(offset).limit(limit).toArray(), cursor2.skip(offset).limit(limit).toArray()])
    }).then(results => {
      results = _.union(...results)
      return util.handleProperties(this, results, query.properties)
    })
  }

  /**
   * Return a Promise with an array of concept data.
   */
  getTop(req, res) {
    let query = req.query
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    let criteria
    if (query.uri) {
      criteria = { "topConceptOf.uri": query.uri }
    } else {
      // Search for all top concepts in all vocabularies
      criteria = { topConceptOf: { $exists: true } }
    }
    let cursor = this.conceptCollection.find(criteria)
    return cursor.count().then(total => {
      // Add headers
      util.setPaginationHeaders({ req, res, limit, offset, total })
      return cursor.skip(offset).limit(limit).toArray()
    }).then(results => {
      return util.handleProperties(this, results, query.properties)
    })
  }

  /**
   * Return a Promise with an array of concept data.
   */
  getNarrower(req, res) {
    let query = req.query
    if (!query.uri) {
      return Promise.resolve([])
    }
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    let uri = query.uri
    return this._getNarrower(uri).then(results => {
      // Add headers
      util.setPaginationHeaders({ req, res, limit, offset, total: results.length })
      return results.slice(offset, offset+limit)
    }).then(results => {
      return util.handleProperties(this, results, query.properties)
    })
  }

  // Internal function for getNarrower
  _getNarrower(uri) {
    return this.conceptCollection.find({ broader: { $elemMatch: { uri: uri } } }).toArray()
  }

  /**
   * Return a Promise with an array of concept data.
   */
  getAncestors(req, res) {
    let query = req.query
    if (!query.uri) {
      return Promise.resolve([])
    }
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    let uri = query.uri
    // First retrieve the concept object from database
    return this.conceptCollection.find({ uri: uri })
      .toArray()
      .then(result => {
        if (!result.length) {
          return Promise.resolve(null)
        }
        let concept = result[0]
        if (concept.broader && concept.broader.length) {
          // Load next parent
          let parentUri = concept.broader[0].uri
          return this._getAncestors(parentUri).then(ancestors => {
            // Add headers
            util.setPaginationHeaders({ req, res, limit, offset, total: ancestors.length })
            return ancestors.slice(offset, offset+limit)
          })
        } else {
          return Promise.resolve(null)
        }
      }).then(results => {
        if (results == null) {
          results = []
          // Add headers
          util.setPaginationHeaders({ req, res, limit, offset, total: 0 })
        }
        return util.handleProperties(this, results, query.properties)
      })
  }

  // Internal function for getAncestors
  _getAncestors(uri) {
    return this.conceptCollection.find({ uri: uri })
      .toArray()
      .then(result => {
        if (!result.length) {
          // URI not found in database
          return Promise.resolve([])
        }
        let concept = result[0]
        if (concept.broader && concept.broader.length) {
          // Load next parent
          let parentUri = concept.broader[0].uri
          return this._getAncestors(parentUri).then(results => {
            return results.concat([concept])
          })
        } else {
          return Promise.resolve([concept])
        }
      })
  }

  /**
   * Return a Promise with suggestions, either in OpenSearch Suggest Format or JSKOS (?format=jskos).
   */
  getSuggestions(req, res) {
    let query = req.query
    let search = query.search || ""
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    let format = query.format || ""
    return this.searchConcept(search, query.voc).then(results => {
      if (format.toLowerCase() == "jskos") {
        // Return in JSKOS format
        return results.slice(offset, offset+limit)
      }
      // Transform to OpenSearch Suggest Format
      let labels = []
      let descriptions = []
      let uris = []
      let currentOffset = offset
      for (let result of results) {
        // Skip if offset is not reached
        if (currentOffset) {
          currentOffset -= 1
          continue
        }
        // Skip if limit is reached
        if (labels.length >= limit) {
          break
        }
        let prefLabel = result.prefLabel ? (result.prefLabel.de || result.prefLabel.en || "") : ""
        labels.push(result.notation[0] + " " + prefLabel) // + " (" + result.priority + ")")
        descriptions.push("")
        uris.push(result.uri)
      }
      // Add headers
      util.setPaginationHeaders({
        req,
        res,
        limit,
        offset,
        total: results.length
      })
      return [
        search, labels, descriptions, uris
      ]
    }).catch(error => {
      console.log("Error in getSuggestion:", error)
      return []
    })
  }

  /**
   * Return a Promise with an array of suggestions in JSKOS format.
   */
  search(req, res) {
    let query = req.query
    let search = query.query || query.search || ""
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    return this.searchConcept(search, query.voc).then(results => {
      // Add headers
      util.setPaginationHeaders({
        req,
        res,
        limit,
        offset,
        total: results.length
      })
      return results.slice(offset, offset+limit)
    }).catch(error => {
      console.log(error)
      return []
    }).then(results => {
      return util.handleProperties(this, results, query.properties)
    })
  }

  searchConcept(search, voc) {
    // Don't try to search for an empty query
    if (!search.length) {
      return Promise.resolve([])
    }
    let query
    // let projectAndSort = {}
    if (search.length > 2) {
      // Use text search for queries longer than two characters
      query = {
        $text: {
          $search: "\"" + search + "\""
        }
      }
      // Projekt and sort on text score
      // projectAndSort = { score: { $meta: "textScore" } }
    } else {
      // Search for notations specifically for one or two characters
      query = {
        _keywordsNotation: {
          $regex: "^" + search.toUpperCase()
        }
      }
    }
    // Also search for exact matches with the URI (in field _id)
    query = { $or: [query, { _id: search }] }
    // Filter by scheme uri
    if (voc) {
      query = { $and: [query, { "inScheme.uri": voc } ] }
    }
    return this.conceptCollection.find(query)
      // .project(projectAndSort) // FIXME: Either test more and include, or remove completely
      // .sort(projectAndSort)
      // .limit(20000)
      .toArray()
      .then(results => {
        let _search = search.toUpperCase()
        // Prioritize results
        for (let result of results) {
          let priority = 100
          if (result.notation && result.notation.length > 0) {
            let _notation = result.notation[0].toUpperCase()
            // Shorter notation equals higher priority
            priority -= _notation.length
            // Notation equals search means highest priority
            if (_search == _notation) {
              priority += 1000
            }
            // Notation starts with serach means higher priority
            if (_notation.startsWith(_search)) {
              priority += 150
            }
          }
          // prefLabel/altLabel equals search means very higher priority
          for (let [labelType, factor] of [["prefLabel", 2.0], ["altLabel", 1.0], ["creator.prefLabel", 0.8], ["definition", 0.7]]) {
            let labels = []
            // Collect all labels
            for (let label of Object.values(_.get(result, labelType, {}))) {
              if (Array.isArray(label)) {
                labels = labels.concat(label)
              } else {
                labels.push(label)
              }
            }
            let matchCount = 0
            let priorityDiff = 0
            for (let label of labels) {
              let _label
              try {
                _label = label.toUpperCase()
              } catch(error) {
                console.log(label, error)
                continue
              }
              if (_search == _label) {
                priorityDiff += 100
                matchCount += 1
              } else if (_label.startsWith(_search)) {
                priorityDiff += 50
                matchCount += 1
              } else if (_label.indexOf(_search) > 0) {
                priorityDiff += 15
                matchCount += 1
              }
            }
            matchCount = Math.pow(matchCount, 2) || 1
            priority += priorityDiff * (factor / matchCount)
          }
          result.priority = priority
        }
        // Sort results first by priority, then by notation
        results = results.sort((a, b) => {
          if (a.priority != b.priority) {
            return b.priority - a.priority
          }
          if (a.notation && a.notation.length && b.notation && b.notation.length) {
            if (b.notation[0] > a.notation[0]) {
              return -1
            } else {
              return 1
            }
          } else {
            return 0
          }
        })
        return results
      }).catch(error => {
        console.log("Error in searchConcept:", error)
        return []
      })
  }

}

module.exports = TerminologyProvider
