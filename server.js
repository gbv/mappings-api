const config = require("./config")
const utils = require("./utils")

config.log(`Running in ${config.env} mode.`)

if (!config.baseUrl) {
  config.warn("Warning: If you're using jskos-server behind a reverse proxy, it is necessary to add `baseUrl` to the configuration file!")
}

// Initialize express with settings
const express = require("express")
const app = express()
app.set("json spaces", 2)

// Database connection
const mongoose = require("mongoose")
const connect = async () => {
  try {
    await mongoose.connect(`${config.mongo.url}/${config.mongo.db}`, config.mongo.options)
  } catch(error) {
    config.log("Error connecting to database, reconnect in a few seconds...")
  }
}
// Connect immediately on startup
connect()
const db = mongoose.connection

db.on("error", () => {
  mongoose.disconnect()
})
db.on("connected", () => {
  config.log("Connected to database")
})
db.on("disconnected", () => {
  setTimeout(connect, 2500)
})

// Add default headers
app.use(utils.addDefaultHeaders)

// Add body-parser middleware
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

// Set some properties on req that will be used by other middleware
app.use(utils.addMiddlewareProperties)

// Add routes

// Root path for static page
// TODO: - Add structure and CSS?
const readme = require("marked")(require("fs").readFileSync(require("path").join(__dirname + "/README.md")).toString())
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html")
  res.send(readme)
})
// JSON Schema for /status
app.use("/status.schema.json", express.static(__dirname + "/status.schema.json"))
// Status page /status
app.use("/status", require("./routes/status"))
// Database check middleware
const { DatabaseAccessError } = require("./errors")
app.use((req, res, next) => {
  if (db.readyState === 1) {
    next()
  } else {
    // No connection to database, return error
    next(new DatabaseAccessError())
  }
})
// /checkAuth
const auth = require("./utils/auth")
app.get("/checkAuth", auth.default, (req, res) => {
  res.sendStatus(204)
})
// Scheme related endpoints
if (config.schemes) {
  app.use("/voc", require("./routes/schemes"))
}
// Mapping related endpoints
if (config.mappings) {
  if (config.concordances !== false) {
    app.use("/concordances", require("./routes/concordances"))
  }
  app.use("/mappings", require("./routes/mappings"))
}
// Annotation related endpoints
if (config.annotations) {
  app.use("/annotations", require("./routes/annotations"))
}
// Concept related endpoints
if (config.concepts) {
  app.use(require("./routes/concepts"))
}

// Error handling
const errors = require("./errors")
app.use((error, req, res, next) => {
  // Check if error is defined in errors
  if (Object.values(errors).includes(error.constructor)) {
    res.status(error.statusCode).send({
      error: error.constructor.name,
      status: error.statusCode,
      message: error.message,
    })
  } else {
    next(error)
  }
})

const start = async () => {
  const portfinder = require("portfinder")
  let port = config.port
  if (config.env == "test") {
    portfinder.basePort = config.port
    port = await portfinder.getPortPromise()
  }
  app.listen(port, () => {
    config.log(`Now listening on port ${port}`)
  })
}
// Start express server immediately even if database is not yet connected
start()

module.exports = { db, app }
