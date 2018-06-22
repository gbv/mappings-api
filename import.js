#!/usr/bin/env node

/**
 * Import script for mappings, terminologies, and concepts.
 * For help, see:
 * $ npm run import -- -h
 */

const meow = require("meow")
var fs = require("fs")

// Read command line arguments
const cli = meow(`
Usage
  $ npm run import -- [OPTIONS]
  Note the obligatory -- after import.

Options
  GNU long option         Option      Meaning
  --concepts      <file>  -c <file>   Import file as concepts
  --terminologies <file>  -t <file>   Import file as terminologies
  --mappings      <file>  -m <file>   Import file as mappings
  --remove                -r          Remove all records before importing
  --indexes               -i          Create indexes (for all object types that are being imported)

Examples
  $ npm run import -- -r -i -t terminologies.ndjson -c ddc.ndjson -c rvk.ndjson
`, {
  flags: {
    concepts: {
      type: "string",
      alias: "c"
    },
    terminologies: {
      type: "string",
      alias: "t"
    },
    mappings: {
      type: "string",
      alias: "m"
    },
    remove: {
      type: "boolean",
      alias: "r",
      default: false
    },
    indexes: {
      type: "boolean",
      alias: "i",
      default: false
    },
    help: {
      type: "boolean",
      alias: "h",
      default: false
    }
  }
})
if (cli.flags.help) {
  cli.showHelp()
  process.exit(0)
}
// Check if at least one of the arguments are given
if (!cli.flags.concepts && !cli.flags.terminologies && !cli.flags.mappings && !cli.flags.indexes) {
  cli.showHelp()
  process.exit(1)
}
// Check if all given arguments are actual files
let files = { concepts: [], terminologies: [], mappings: [] }
let typesToDelete = []
for (let type of Object.keys(files)) {
  if (cli.flags[type]) {
    files[type] = Array.isArray(cli.flags[type]) ? cli.flags[type] : [cli.flags[type]]
  } else {
    typesToDelete.push(type)
  }
}

let isError = false
for (let file of [].concat(files.concepts, files.terminologies, files.mappings)) {
  if (!fs.existsSync(file)) {
    isError = true
    console.log("Error: File", file, "does not exist.")
  }
}
if (isError) {
  process.exit(1)
}
// Delete unused keys from files
for(let type of typesToDelete) {
  delete files[type]
}

const mongo = require("mongodb").MongoClient
const config = require("./config")
const url = `mongodb://${config.mongodb.host}:${config.mongodb.port}`
const TerminologyProvider = require("./lib/terminology-provider")

mongo.connect(url, {
  reconnectTries: 60,
  reconnectInterval: 1000,
  bufferMaxEntries: 0
}, (err, client) => {
  if (err) {
    console.log(err)
    process.exit(1)
  }

  let db = client.db(config.mongodb.db)
  console.log("Connected to database", config.mongodb.db)
  let terminologyProvider = new TerminologyProvider(db.collection("terminologies"), db.collection("concepts"))

  // Remove if necessary
  let promises = []
  if (cli.flags.remove) {
    for(let type of Object.keys(files)) {
      promises.push(db.collection(type).remove({}).then(() => { console.log("Cleared collection", type) }))
    }
  }

  Promise.all(promises)
    .catch(error => {
      console.log("Error:", error)
      client.close()
    })
    .then(() => {
      if (!cli.flags.indexes) {
        return
      }
      let promises = []
      // Create indexes
      for(let type of Object.keys(files)) {
        let indexes = []
        if (type == "concepts") {
          indexes.push({ "broader.uri": 1 })
          indexes.push({ "topConceptOf.uri": 1 })
          indexes.push({ "inScheme.uri": 1 })
          indexes.push({ "uri": 1 })
          indexes.push({ "notation": 1 })
          indexes.push({ "prefLabel.de": 1 })
          indexes.push({ "prefLabel.en": 1 })
          indexes.push({ "notation": 1, "prefLabel.de": 1, "prefLabel.en": 1 })
        }
        for(let index of indexes) {
          promises.push(db.collection(type).createIndex(index).then(() => { console.log("Created index on", type) }))
        }
      }
      return Promise.all(promises)
    })
    .then(() => {
      let promises = []
      for (let type of Object.keys(files)) {
        for (let file of files[type]) {
          console.log("Reading", file)
          let data = fs.readFileSync(file, "utf8")
          let json
          if (file.endsWith("ndjson")) {
            // Read file as newline delimited JSON
            json = []
            for(let line of data.split("\n")) {
              if (line != "") {
                json.push(JSON.parse(line))
              }
            }
          } else {
            // Read file as normal JSON
            json = JSON.parse(data)
          }
          // Convert single object to array
          if (typeof json === "object") {
            json = [json]
          }
          // Add URIs as _id for all concepts and terminologies
          if (type == "concepts" || type == "terminologies") {
            for(let object of json) {
              object._id = object.uri
            }
          }
          // Add "inScheme" for all top concepts
          if (type == "concepts") {
            for(let object of json) {
              if (!object.inScheme && object.topConceptOf) {
                object.inScheme = object.topConceptOf
              }
            }
          }
          promises.push(
            db.collection(type).insertMany(json).then(result => {
              console.log("", result.insertedCount, type, "inserted, doing adjustments now...")
              if (type == "concepts") {
                let done = 0
                let ids = Object.values(result.insertedIds)
                let dealWithNext = function(index) {
                  if (index >= ids.length) {
                    return Promise.resolve()
                  } else {
                    let _id = ids[index]
                    return terminologyProvider.getNarrower({ uri: _id }).then(result => {
                      // Add narrower field to object, either [] or [null]
                      let narrower = result.length == 0 ? [] : [null]
                      return db.collection(type).update({ _id: _id }, { $set: { narrower: narrower } })
                    }).then(() => {
                      done += 1
                      if (done % 5000 == 0) {
                        console.log(" -", done, "objects done.")
                      }
                      return dealWithNext(index + 1)
                    }).catch(error => {
                      console.log(error)
                    })
                  }
                }
                let promise = dealWithNext(0)
                return promise
              }
            }).then(() => {
              console.log(" ... adjustments done.")
            })
          )

        }
      }
      return Promise.all(promises)
    }).then(() => {
      console.log("Closing database")
      client.close()
    })
})