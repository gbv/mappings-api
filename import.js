#!/usr/bin/env node

/**
 * Import script for mappings, terminologies, and concepts.
 * For help, see:
 * $ npm run import -- -h
 */

const config = require("./config")
const meow = require("meow")

// Read command line arguments
const cli = meow(`
Usage
  $ npm run import -- [OPTIONS]
  Note the obligatory -- after import.

Options
  GNU long option         Option      Meaning
  --concepts      <file>  -c <file>   Import file as concepts
  --terminologies <file>  -t <file>   Import file as terminologies
  --concordances  <file>  -k <file>   Import file as concordances
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
    concordances: {
      type: "string",
      alias: "k"
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
if (!cli.flags.concepts && !cli.flags.terminologies && !cli.flags.concordances && !cli.flags.mappings && !cli.flags.indexes && !cli.flags.remove) {
  cli.showHelp()
  process.exit(1)
}
// Check if all given arguments are actual files
let files = { concepts: [], terminologies: [], concordances: [], mappings: [] }
let typesToDelete = []
for (let type of Object.keys(files)) {
  if (cli.flags[type]) {
    files[type] = Array.isArray(cli.flags[type]) ? cli.flags[type] : [cli.flags[type]]
  } else {
    if (cli.flags[type] != "") {
      typesToDelete.push(type)
    }
  }
}

// Delete unused keys from files if at least one stays
if (typesToDelete.length < Object.keys(files).length) {
  for(let type of typesToDelete) {
    delete files[type]
  }
}

const { importFile, createIndexes, clearCollection } = require("./lib/import")

// Remove if necessary
let promises = []
if (cli.flags.remove) {
  for(let type of Object.keys(files)) {
    promises.push(clearCollection(type))
  }
}

Promise.all(promises).catch(error => {
  config.log("Error:", error)
  client.close()
}).then(() => {
  if (!cli.flags.indexes) {
    return
  }
  config.log("Creating indexes...")
  let promises = []
  // Create indexes
  for(let type of Object.keys(files)) {
    promises.push(createIndexes(type))
    // Add indexes for mappings if concordances are imported
    if (type == "concordances" && !Object.keys(files).includes("mappings")) {
      promises.push(createIndexes("mappings"))
    }
  }
  return Promise.all(promises)
}).then(() => {
  let promises = []
  for (let type of Object.keys(files)) {
    for (let file of files[type]) {
      config.log("Reading", file)
      promises.push(importFile(type, file, { reload: true }))
    }
  }
  return Promise.all(promises)
})
