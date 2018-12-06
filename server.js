/**
 * Simple JSON API to retrieve JSKOS Concept Mappings for mappings between RVK and GND.
 *
 * If the database doesn't exist yet, import the mappings like this:
 * mongoimport --db cocoda_api --collection mappings --file mappings.ndjson
 *
 * Import vocabularies into collection "terminologies" and their concepts into collection "concepts":
 * mongoimport --db cocoda_api --collection terminologies --file terminologies.ndjson
 * mongoimport --db cocoda_api --collection concepts --file concepts.ndjson
 *
 * Download the file from here: http://coli-conc.gbv.de/concordances/
 */

const config = require("./config")
const express = require("express")
const bodyParser = require("body-parser")
const app = express()
const mongo = require("mongodb").MongoClient
const MappingProvider = require("./lib/mapping-provider")
const TerminologyProvider = require("./lib/terminology-provider")
const StatusProvider = require("./lib/status-provider")
const _ = require("lodash")
const jskos = require("jskos-tools")
const portfinder = require("portfinder")
const { Transform } = require("stream")
const JSONStream = require("JSONStream")

// Promise for MongoDB db
const db = mongo.connect(config.mongoUrl, config.mongoOptions).then(client => {
  return client.db(config.mongoDb)
}).catch(error => {
  throw error
})

db.then(db => {
  config.log(`connected to MongoDB ${config.mongoUrl} (database: ${config.mongoDb})`)
  mappingProvider = new MappingProvider(db.collection("mappings"), db.collection("concordances"))
  terminologyProvider = new TerminologyProvider(db.collection("terminologies"), db.collection("concepts"))
  statusProvider = new StatusProvider(db)
  if (config.env == "test") {
    portfinder.basePort = config.port
    return portfinder.getPortPromise()
  } else {
    return Promise.resolve(config.port)
  }
}).then(port => {
  app.listen(port, () => {
    config.log(`listening on port ${port}`)
  })
}).catch(error => {
  console.error("Error with database or express:", error)
})

// Add default headers
app.use(function (req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept")
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, Link")
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  next()
})

// Add body-parser middleware
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())

// Recursively remove all fields starting with _ from response
function cleanJSON(json) {
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

function adjustSchemes(schemes) {
  // Remove MongoDB specific fields, add JSKOS specific fields
  schemes.forEach(scheme => {
    delete scheme._id
    scheme["@context"] = "https://gbv.github.io/jskos/context.json"
    scheme.type = scheme.type || ["http://www.w3.org/2004/02/skos/core#ConceptScheme"]
  })
  return schemes
}

function adjustConcepts(concepts) {
  // Remove MongoDB specific fields, add JSKOS specific fields
  concepts.forEach(concept => {
    delete concept._id
    concept["@context"] = "https://gbv.github.io/jskos/context.json"
    concept.type = concept.type || ["http://www.w3.org/2004/02/skos/core#Concept"]
  })
  return concepts
}

function handleDownload(req, res, results, filename) {
  /**
   * Transformation object to remove _id parameter from objects in a stream.
   */
  const removeIdTransform = new Transform({
    objectMode: true,
    transform(chunk, encoding, callback) {
      cleanJSON(chunk)
      this.push(chunk)
      callback()
    }
  })
  // Default transformation: JSON
  let transform = JSONStream.stringify("[\n", ",\n", "\n]\n")
  let fileEnding = "json"
  let first = true, delimiter = ","
  switch (req.query.download) {
  case "ndjson":
    fileEnding = "ndjson"
    res.set("Content-Type", "application/x-ndjson; charset=utf-8")
    transform = new Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        this.push(JSON.stringify(chunk) + "\n")
        callback()
      }
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
    transform = new Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        // Small workaround to prepend a line to CSV
        if (first) {
          this.push(`"fromNotation"${delimiter}"toNotation"${delimiter}"type"\n`)
          first = false
        }
        let mappingToCSV = jskos.mappingToCSV({
          lineTerminator: "\r\n",
          delimiter,
        })
        this.push(mappingToCSV(chunk))
        callback()
      }
    })
    break
  }
  // Add file header
  res.set("Content-disposition", `attachment; filename=${filename}.${fileEnding}`)
  // results is a database cursor
  results.stream()
    .pipe(removeIdTransform)
    .pipe(transform)
    .pipe(res)
}

const mung = require("express-mung")
app.use(mung.json((cleanJSON)))

app.get("/status", (req, res) => {
  statusProvider.getStatus()
    .then(result => {
      res.json(result)
    })
})

app.get("/concordances", (req, res) => {
  let supportedTypes = ["json", "ndjson"]
  if (req.query.download && !supportedTypes.includes(req.query.download)) {
    req.query.download = null
  }
  mappingProvider.getConcordances(req, res)
    .catch(err => res.send(err))
    .then(results => {
      if (req.query.download) {
        handleDownload(req, res, results, "concordances")
      } else {
        res.json(results)
      }
    })
})

app.get("/mappings", (req, res) => {
  let supportedTypes = ["json", "ndjson", "csv", "tsv"]
  if (req.query.download && !supportedTypes.includes(req.query.download)) {
    req.query.download = null
  }
  mappingProvider.getMappings(req, res)
    .catch(err => res.send(err))
    .then(results => {
      if (req.query.download) {
        handleDownload(req, res, results, "mappings")
      } else {
        // Remove MongoDB specific fields, add JSKOS specific fields
        results.forEach(mapping => {
          delete mapping._id
          mapping["@context"] = "https://gbv.github.io/jskos/context.json"
        })
        res.json(results)
      }
    })
})

app.post("/mappings", (req, res) => {
  mappingProvider.saveMapping(req, res)
    .catch(err => res.send(err))
    .then(result => {
      if (!result) {
        res.json({
          ok: 0,
          error: "mapping could not be saved"
        })
      } else {
        res.json({
          ok: 1,
          mapping: result
        })
      }
    })
})

app.get("/mappings/suggest", (req, res) => {
  mappingProvider.getNotationSuggestions(req, res)
    .catch(err => res.send(err))
    .then(results => {
      res.json(results)
    })
})

app.get("/mappings/voc", (req, res) => {
  mappingProvider.getMappingSchemes(req, res)
    .catch(err => res.send(err))
    .then(adjustSchemes)
    .then(results => {
      res.json(results)
    })
})

app.get("/voc", (req, res) => {
  terminologyProvider.getVocabularies(req, res)
    .catch(err => res.send(err))
    .then(adjustSchemes)
    .then(results => {
      res.json(results)
    })
})

app.get("/data", (req, res) => {
  terminologyProvider.getDetails(req, res)
    .catch(err => res.send(err))
    .then(adjustConcepts)
    .then(results => {
      res.json(results)
    })
})

app.get("/voc/top", (req, res) => {
  terminologyProvider.getTop(req, res)
    .catch(err => res.send(err))
    .then(adjustConcepts)
    .then(results => {
      res.json(results)
    })
})

app.get("/narrower", (req, res) => {
  terminologyProvider.getNarrower(req, res)
    .catch(err => res.send(err))
    .then(adjustConcepts)
    .then(results => {
      res.json(results)
    })
})

app.get("/ancestors", (req, res) => {
  terminologyProvider.getAncestors(req, res)
    .catch(err => res.send(err))
    .then(adjustConcepts)
    .then(results => {
      res.json(results)
    })
})

app.get("/suggest", (req, res) => {
  terminologyProvider.getSuggestions(req, res)
    .catch(err => res.send(err))
    .then(results => {
      res.json(results)
    })
})

app.get("/search", (req, res) => {
  terminologyProvider.search(req, res)
    .catch(err => res.send(err))
    .then(adjustConcepts)
    .then(results => {
      res.json(results)
    })
})

module.exports = {
  db, app
}
