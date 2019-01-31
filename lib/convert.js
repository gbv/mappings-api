/**
 * This is a single-use conversion script that converts all mappings in the database that use the old format (ObjectId as _id and no URI) to the new format (string as _id and proper URI).
 */

const config = require("../config")
const _ = require("lodash")
const mongo = require("mongodb").MongoClient

function connect() {
  return mongo.connect(config.mongoUrl, config.mongoOptions).then(client => {
    return { client, db: client.db(config.mongoDb) }
  }).catch(error => {
    config.log(error)
    return { client: null, db: null }
  })
}

connect().then(({ client, db }) => {
  let collection = db.collection("mappings")
  let query = { confirmed: { $exists: true }, uri: { $exists: false }}
  return collection.find(query).toArray().then(mappings => {
    console.log("Found", mappings.length, "mappings that need to be adjusted")
    for (let mapping of mappings) {
      _.unset(mapping, "confirmed")
      mapping._id = `${mapping._id}`
      mapping.uri = `https://coli-conc.gbv.de/kenom/api/mappings/${mapping._id}`
    }
    // Add mappings to database
    return collection.insertMany(mappings).then(result => {
      let ids = Object.values(result.insertedIds)
      console.log(`${ids.length} converted mappings inserted into database`)
      if (ids.length == mappings.length) {
        return collection.remove(query).then(() => true).catch(error => {
          console.log("Error when removing:", error)
          return false
        })
      }
      return Promise.resolve(false)
    }).then(success => {
      if (success) {
        console.log("Old mappings successfully removed")
      } else {
        console.log("Error: Old mappings not removed")
      }
    })
  }).catch(() => null).finally(() => {
    console.log("Closing database")
    client.close()
  })
})
