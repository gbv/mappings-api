/* eslint-env node, mocha */

const chai = require("chai")
const chaiAsPromised = require("chai-as-promised")
chai.use(chaiAsPromised)
const chaiHttp = require("chai-http")
chai.use(chaiHttp)
// eslint-disable-next-line no-unused-vars
const should = chai.should()
const server = require("../server")
const assert = require("assert")
const cpexec = require("child_process").exec
const _ = require("lodash")
const { assertMongoDB, dropDatabaseBeforeAndAfter } = require("./test-utils")

// Prepare jwt
const jwt = require("jsonwebtoken")

const fs = require("fs")

// Prepare JSON Schemas
const ajvErrorsToString = require("../utils/ajvErrorsToString")
const ajv = new require("ajv")({ allErrors: true })
const configSchema = JSON.parse(fs.readFileSync(__dirname + "/../config/config.schema.json"))
ajv.addSchema(configSchema)
const statusSchema = JSON.parse(fs.readFileSync(__dirname + "/../status.schema.json"))
ajv.addSchema(statusSchema)

const user = {
  uri: "http://test.user",
  name: "Test User",
  identities: {
    test: {},
  },
}
const token = jwt.sign({ user }, "test")

const userWithModerating = {
  uri: "http://test-moderating.user",
  name: "Test User",
  identities: {
    test: {},
  },
}
const tokenWithModerating = jwt.sign({ user: userWithModerating }, "test")

const userNotOnWhitelist = {
  uri: "http://test2.user",
  name: "Test User",
  identities: {
    test: {},
  },
}
const tokenNotOnWhitelist = jwt.sign({ user: userNotOnWhitelist }, "test")

const userMissingIdentity = {
  uri: "http://test.user",
  name: "Test User",
}
const tokenMissingIdentity = jwt.sign({ user: userMissingIdentity }, "test")

// Hide UnhandledPromiseRejectionWarning on output
process.on("unhandledRejection", () => {})

// Mapping for POST/PUT/PATCH/DELETE
let mapping = {
  from: {
    memberSet: [
      {
        uri: "http://dewey.info/class/612.112/e23/",
        notation: [
          "612.112",
        ],
      },
    ],
  },
  to: {
    memberSet: [
      {
        uri: "http://www.wikidata.org/entity/Q42395",
        notation: [
          "Q42395",
        ],
      },
    ],
  },
  fromScheme: {
    uri: "http://dewey.info/scheme/edition/e23/",
    notation: [
      "DDC",
    ],
  },
  toScheme: {
    uri: "http://bartoc.org/en/node/1940",
    notation: [
      "WD",
    ],
  },
  creator: [
    {
      prefLabel: {
        de: "Stefan Peters (VZG)",
      },
      uri: user.uri,
    },
  ],
  type: [
    "http://www.w3.org/2004/02/skos/core#relatedMatch",
  ],
}

describe("Configuration", () => {

  for (let file of [
    "config/config.default.json",
    "config/config.test.json",
  ].concat(fs.readdirSync("./test/configs").map(f => `test/configs/${f}`))) {
    const shouldFail = file.includes("fail-")
    it(`should ${shouldFail ? "not " : ""}validate ${file}`, async () => {
      let valid = false
      try {
        const data = require(`../${file}`)
        valid = ajv.validate(configSchema, data)
      } catch (error) {
        // Ignore error
      }
      if (shouldFail) {
        assert.ok(!valid, "File passed validation even though it shouldn't.")
      } else {
        const notValidMessage = ajvErrorsToString(ajv.errors || [])
        assert.ok(valid, notValidMessage)
      }
    })
  }

})

assertMongoDB()

describe("Express Server", () => {

  dropDatabaseBeforeAndAfter()

  describe("GET /status", () => {

    it("should GET status ok = 1", done => {
      chai.request(server.app)
        .get("/status")
        .end((err, res) => {
          res.should.have.status(200)
          res.body.should.be.a("object")
          _.get(res.body, "ok", 0).should.be.eql(1)
          res.body.config.should.be.a("object")
          done()
        })
    })

    it("should pass JSON schema", done => {
      chai.request(server.app)
        .get("/status")
        .end((err, res) => {
          res.should.have.status(200)
          res.body.should.be.a("object")
          const valid = ajv.validate(statusSchema, res.body)
          const notValidMessage = ajvErrorsToString(ajv.errors || [])
          valid.should.be.eql(true, notValidMessage)
          done()
        })
    })

    it("should GET status.schema.json", done => {
      chai.request(server.app)
        .get("/status.schema.json")
        .end((err, res) => {
          res.should.have.status(200)
          done()
        })
    })

  })

  describe("GET /checkAuth", () => {

    it("should be authorized for user", done => {
      chai.request(server.app)
        .get("/checkAuth")
        .set("Authorization", `Bearer ${token}`)
        .then(res => {
          res.should.have.status(204)
          done()
        })
    })

    it("should not be authorized for userNotOnWhitelist", done => {
      chai.request(server.app)
        .get("/checkAuth")
        .set("Authorization", `Bearer ${tokenNotOnWhitelist}`)
        .then(res => {
          res.should.have.status(403)
          res.body.should.be.an("object")
          res.body.error.should.be.eql("ForbiddenAccessError")
          done()
        })
    })

    it("should be not be authorized for userMissingIdentity", done => {
      chai.request(server.app)
        .get("/checkAuth")
        .set("Authorization", `Bearer ${tokenMissingIdentity}`)
        .then(res => {
          res.should.have.status(403)
          res.body.should.be.an("object")
          res.body.error.should.be.eql("ForbiddenAccessError")
          done()
        })
    })

    it("should not be authorized for userMissingIdentity for create annotations", done => {
      chai.request(server.app)
        .get("/checkAuth")
        .query({
          type: "annotations",
          action: "create",
        })
        .set("Authorization", `Bearer ${tokenMissingIdentity}`)
        .then(res => {
          res.should.have.status(403)
          res.body.should.be.an("object")
          res.body.error.should.be.eql("ForbiddenAccessError")
          done()
        })
    })

    // identityProviders is set to null for annotations.delete
    it("should be authorized for userMissingIdentity for delete annotations", done => {
      chai.request(server.app)
        .get("/checkAuth")
        .query({
          type: "annotations",
          action: "delete",
        })
        .set("Authorization", `Bearer ${tokenMissingIdentity}`)
        .then(res => {
          res.should.have.status(204)
          done()
        })
    })

  })

  describe("GET /concordances", () => {

    it("should GET an empty array", done => {
      chai.request(server.app)
        .get("/concordances")
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("0")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(0)
          done()
        })
    })

    it("should GET two concordances", done => {
      // Add concordances to database
      cpexec("NODE_ENV=test ./bin/import.js concordances ./test/concordances/concordances.ndjson", (err) => {
        if (err) {
          done(err)
          return
        }
        chai.request(server.app)
          .get("/concordances")
          .end((err, res) => {
            res.should.have.status(200)
            res.should.have.header("Link")
            res.should.have.header("X-Total-Count")
            res.headers["x-total-count"].should.be.eql("2")
            res.body.should.be.a("array")
            res.body.length.should.be.eql(2)
            done()
          })
      })
    })

  })

  describe("GET /mappings", () => {

    it("should GET an empty array", done => {
      chai.request(server.app)
        .get("/mappings")
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("0")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(0)
          done()
        })
    })

    it("should GET three mappings", done => {
      // Add mappings to database
      cpexec("NODE_ENV=test ./bin/import.js mappings ./test/mappings/mapping-ddc-gnd.json", (err) => {
        if (err) {
          done(err)
          return
        }
        chai.request(server.app)
          .get("/mappings")
          .end((err, res) => {
            res.should.have.status(200)
            res.should.have.header("Link")
            res.should.have.header("X-Total-Count")
            res.headers["x-total-count"].should.be.eql("3")
            res.body.should.be.a("array")
            res.body.length.should.be.eql(3)
            done()
          })
      })
    })

    it("should paginate mappings properly", done => {
      chai.request(server.app)
        .get("/mappings")
        .query({
          limit: 2,
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("3")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(2)
          chai.request(server.app)
            .get("/mappings")
            .query({
              limit: 2,
              offset: 2,
            })
            .end((err, res) => {
              res.should.have.status(200)
              res.should.have.header("Link")
              res.should.have.header("X-Total-Count")
              res.headers["x-total-count"].should.be.eql("3")
              res.body.should.be.a("array")
              res.body.length.should.be.eql(1)
              done()
            })
        })
    })

    it("should GET one mapping with URL parameter", done => {
      chai.request(server.app)
        .get("/mappings")
        .query({
          to: "http://d-nb.info/gnd/4499720-6",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          const mapping = _.get(res, "body[0]")
          _.get(mapping, "from.memberChoice[0].uri").should.be.eql("http://dewey.info/class/612.112/e22/")
          mapping.uri.should.be.a("string")
          mapping.uri.endsWith("dc2f1987-de06-5237-b58c-aff2c066cb92").should.be.eql(true)
          done()
        })
    })

    it("should GET one mapping with URL parameter (with direction = backward)", done => {
      chai.request(server.app)
        .get("/mappings")
        .query({
          from: "http://d-nb.info/gnd/4499720-6",
          direction: "backward",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          _.get(res, "body[0].from.memberChoice[0].uri").should.be.eql("http://dewey.info/class/612.112/e22/")
          done()
        })
    })

    it("should GET only mappings from GND", done => {
      // Add mappings to database
      cpexec("yes | NODE_ENV=test ./bin/reset.js -t mappings && NODE_ENV=test ./bin/import.js mappings ./test/mappings/mappings-ddc.json", (err) => {
        if (err) {
          done(err)
          return
        }
        chai.request(server.app)
          .get("/mappings")
          .query({
            from: "612.112",
            to: "612.112",
            mode: "or",
            fromScheme: "GND",
          })
          .end((err, res) => {
            res.should.have.status(200)
            res.should.have.header("Link")
            res.should.have.header("X-Total-Count")
            res.headers["x-total-count"].should.be.eql("2")
            res.body.should.be.a("array")
            res.body.length.should.be.eql(2)
            done()
          })
      })
    })

    it("should have identifiers for all mappings", done => {
      chai.request(server.app)
        .get("/mappings")
        .end((err, res) => {
          res.should.have.status(200)
          res.body.should.be.a("array")
          for (let mapping of res.body) {
            mapping.identifier.should.be.a("array")
            mapping.identifier.filter(id => id.startsWith("urn:jskos:mapping:")).length.should.be.eql(2)
          }
          done()
        })
    })

    it("should GET mappings by identifier", done => {
      chai.request(server.app)
        .get("/mappings")
        .query({
          identifier: "urn:jskos:mapping:content:ecfbefed9712bf4b5c90269ddbb6788bff15b7d6|urn:jskos:mapping:content:fa693e08d92696e453208ce478e988434cc73a0e",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("2")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(2)
          done()
        })
    })

    it("should POST a mapping, then GET it using its URI with the identifier parameter, then DELETE it again", done => {
      let uri, _id
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mapping)
        .then(res => {
          res.should.have.status(201)
          res.body.should.be.a("object")
          res.body.uri.should.be.a("string")
          uri = res.body.uri
          // _id needed for deletion later
          _id = res.body.uri.substring(res.body.uri.lastIndexOf("/") + 1)
          chai.request(server.app)
            .get("/mappings")
            .query({
              identifier: uri,
            })
            .end((err, res) => {
              res.should.have.status(200)
              res.body.should.be.a("array")
              res.body.length.should.be.eql(1)
              res.body[0].uri.should.be.eql(uri)
              // DELETE the mapping
              chai.request(server.app).delete(`/mappings/${_id}`).set("Authorization", `Bearer ${token}`).end((err, res) => {
                res.should.have.status(204)
                done()
              })
            })
        })
    })

  })

  describe("GET /mappings/:_id", () => {

    it("should GET error 404 if ID does not exist", done => {
      chai.request(server.app)
        .get("/mappings/5bf3dad9ad10c2917066d8af")
        .end((err, res) => {
          res.should.have.status(404)
          done()
        })
    })

    it("should POST a mapping, then GET the mapping with its uri, then DELETE it with its uri", done => {
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mapping)
        .end((err, res) => {
          res.should.have.status(201)
          res.body.should.be.a("object")
          res.body.uri.should.be.a("string")
          let _id = res.body.uri.substring(res.body.uri.lastIndexOf("/") + 1)
          chai.request(server.app).get(`/mappings/${_id}`).end((err, res) => {
            res.should.have.status(200)
            res.body.should.be.a("object")
            // Due to chai, the URL will be different, so we will remove it from the objects
            _.isEqual(_.omit(res.body, ["uri", "identifier", "creator", "created", "modified", "@context"]), _.omit(mapping, ["creator"])).should.be.eql(true)
            chai.request(server.app).delete(`/mappings/${_id}`).set("Authorization", `Bearer ${token}`).end((err, res) => {
              res.should.have.status(204)
              done()
            })
          })
        })
    })

  })

  describe("GET /mappings/voc", () => {

    // Reinsert mappings again
    before(done => {
      cpexec("yes | NODE_ENV=test ./bin/reset.js -t mappings && NODE_ENV=test ./bin/import.js mappings ./test/mappings/mappings-ddc.json", (err) => {
        if (err) {
          done(err)
          return
        }
        done()
      })
    })

    it("should GET appropriate results", done => {
      chai.request(server.app)
        .get("/mappings/voc")
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("3")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(3)
          done()
        })
    })

    it("should GET appropriate results with mode=and", done => {
      chai.request(server.app)
        .get("/mappings/voc")
        .query({
          from: "http://dewey.info/class/612.112/e23/",
          to: "http://rvk.uni-regensburg.de/nt/WW_8840",
          mode: "and",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("2")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(2)
          let total = res.body.reduce((total, current) => {
            return total + (current.fromCount || 0) + (current.toCount || 0)
          }, 0)
          total.should.be.eql(2)
          done()
        })
    })

    it("should GET appropriate results with mode=or", done => {
      chai.request(server.app)
        .get("/mappings/voc")
        .query({
          from: "http://dewey.info/class/612.112/e23/",
          to: "http://rvk.uni-regensburg.de/nt/WW_8840",
          mode: "or",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("2")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(2)
          let total = res.body.reduce((total, current) => {
            return total + (current.fromCount || 0) + (current.toCount || 0)
          }, 0)
          total.should.be.eql(8)
          done()
        })
    })

  })

  describe("GET /mappings/suggest", () => {

    it("should GET correct suggestions", done => {
      let search = "6"
      chai.request(server.app)
        .get("/mappings/suggest")
        .query({
          search,
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("3")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(4)
          res.body[0].should.be.eql(search)
          res.body[1].should.be.a("array")
          res.body[1].length.should.be.eql(3)
          res.body[2].length.should.be.eql(3)
          res.body[3].length.should.be.eql(0)
          done()
        })
    })

  })

  describe("POST /mappings", () => {

    it("should POST a mapping", done => {
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mapping)
        .end((err, res) => {
          res.should.have.status(201)
          res.body.should.be.a("object")
          // Test equality with posted mapping
          _.isEqual(res.body.from, mapping.from).should.be.eql(true)
          _.isEqual(res.body.to, mapping.to).should.be.eql(true)
          _.isEqual(res.body.fromScheme, mapping.fromScheme).should.be.eql(true)
          _.isEqual(res.body.toScheme, mapping.toScheme).should.be.eql(true)
          // Should add mapping identifiers
          res.body.identifier.should.be.a("array")
          // Should add url
          res.body.uri.should.be.a("string")
          done()
        })
    })

    it("should not POST a mapping with `partOf` property", done => {
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(Object.assign({}, mapping, { partOf: [ { uri: "..." } ] }))
        .end((err, res) => {
          res.should.have.status(422)
          done()
        })
    })

    it("should POST a mapping with valid URI", done => {
      let uri, _id
      // 1. POST a new mapping
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mapping)
        .end((err, res) => {
          res.should.have.status(201)
          uri = res.body.uri
          _id = uri.substring(uri.lastIndexOf("/") + 1)
          // 2. DELETE that mapping
          chai.request(server.app).delete(`/mappings/${_id}`).set("Authorization", `Bearer ${token}`).end((err, res) => {
            res.should.have.status(204)
            // 3. POST new mapping with same valid URI as previous POSTED mapping
            chai.request(server.app)
              .post("/mappings")
              .set("Authorization", `Bearer ${token}`)
              .send(Object.assign({ uri }, mapping))
              .end((err, res) => {
                res.should.have.status(201)
                res.body.should.be.a("object")
                res.body.uri.should.be.eql(uri)
                done()
              })
          })
        })
    })

    it("should not POST a mapping with already existing URI", done => {
      let uri
      // 1. POST a new mapping
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mapping)
        .end((err, res) => {
          res.should.have.status(201)
          uri = res.body.uri
          // 2. POST new mapping with same URI as previous POSTED mapping
          chai.request(server.app)
            .post("/mappings")
            .set("Authorization", `Bearer ${token}`)
            .send(Object.assign({ uri }, mapping))
            .end((err, res) => {
              res.should.have.status(422)
              done()
            })
        })
    })

    it("should keep URI in identifier when POSTing a mapping with invalid URI", done => {
      let uri, _id
      // 1. POST a new mapping
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mapping)
        .end((err, res) => {
          res.should.have.status(201)
          uri = res.body.uri
          _id = uri.substring(uri.lastIndexOf("/") + 1)
          // 2. DELETE that mapping
          chai.request(server.app).delete(`/mappings/${_id}`).set("Authorization", `Bearer ${token}`).end((err, res) => {
            res.should.have.status(204)
            // 3. POST new mapping with slightly modified URI as previous POSTED mapping
            chai.request(server.app)
              .post("/mappings")
              .set("Authorization", `Bearer ${token}`)
              .send(Object.assign({ uri: uri.substring(0, uri.length - 1) }, mapping))
              .end((err, res) => {
                res.should.have.status(201)
                res.body.should.be.a("object")
                res.body.uri.should.not.be.eql(uri)
                res.body.identifier.should.be.an("array")
                res.body.identifier.includes(uri.substring(0, uri.length - 1)).should.be.eql(true)
                done()
              })
          })
        })
    })

    it("should bulk POST mappings properly", done => {
      const mappingToBeUpdated = { from: { memberSet: [] }, to: { memberSet: [] } }
      const update = { fromScheme: { uri: "test:test" } }
      const bulkMappings = [
        // Two empty mappings that are still valid
        { from: { memberSet: [] }, to: { memberSet: [] } },
        { from: { memberSet: [] }, to: { memberSet: [] } },
        // One invalid mapping that should be ignored
        {
          partOf: [{}],
        },
      ]
      // 1. Post normal mapping
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mappingToBeUpdated)
        .end((error, res) => {
          res.should.have.status(201)
          res.body.should.be.an("object")
          res.body.uri.should.be.a("string")
          assert.notDeepEqual(res.body.fromScheme, update.fromScheme)
          mappingToBeUpdated.uri = res.body.uri
          let _id = res.body.uri.substring(res.body.uri.lastIndexOf("/") + 1)
          // Add update to bulk mappings
          bulkMappings.push(Object.assign({}, mappingToBeUpdated, update))
          // 2. Post bulk mappings
          chai.request(server.app)
            .post("/mappings")
            .query({
              bulk: true,
            })
            .set("Authorization", `Bearer ${token}`)
            .send(bulkMappings)
            .end((error, res) => {
              assert.equal(error, null)
              res.should.have.status(201)
              res.body.should.be.an("array")
              assert.equal(res.body.length, bulkMappings.length - 1)
              // 3. Check updated mapping
              chai.request(server.app)
                .get(`/mappings/${_id}`)
                .end((error, res) => {
                  assert.equal(error, null)
                  res.should.have.status(200)
                  res.body.should.be.an("object")
                  assert.deepEqual(res.body.fromScheme, update.fromScheme)
                  done()
                })
            })
        })
    })

  })

  describe("POST, then PUT mapping", () => {

    it("should POST a mapping, then PUT a changed mapping", done => {
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mapping)
        .end((err, res) => {
          res.should.have.status(201)
          res.body.uri.should.be.a("string")
          let _id = res.body.uri.substring(res.body.uri.lastIndexOf("/") + 1)
          // Adjust mapping
          let changedMapping = Object.assign({}, mapping, { type: ["http://www.w3.org/2004/02/skos/core#closeMatch"] })
          // PUT that mapping
          chai.request(server.app)
            .put(`/mappings/${_id}`)
            .set("Authorization", `Bearer ${token}`)
            .send(changedMapping)
            .end((err, res) => {
              res.should.have.status(200)
              res.body.should.be.a("object")
              _.isEqual(res.body.type, mapping.type).should.be.eql(false)
              _.isEqual(res.body.type, changedMapping.type).should.be.eql(true)
              done()
            })
        })
    })

  })

  describe("POST, then PATCH mapping", () => {

    it("should POST a mapping, then PATCH the mapping", done => {
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mapping)
        .end((err, res) => {
          res.should.have.status(201)
          res.body.uri.should.be.a("string")
          let _id = res.body.uri.substring(res.body.uri.lastIndexOf("/") + 1)
          let patch = { type: ["http://www.w3.org/2004/02/skos/core#closeMatch"] }
          // PATCH that change
          chai.request(server.app)
            .patch(`/mappings/${_id}`)
            .set("Authorization", `Bearer ${token}`)
            .send(patch)
            .end((err, res) => {
              res.should.have.status(200)
              res.body.should.be.a("object")
              _.isEqual(res.body.type, mapping.type).should.be.eql(false)
              _.isEqual(res.body.type, patch.type).should.be.eql(true)
              done()
            })
        })
    })

  })

  describe("POST, then DELETE mapping", () => {

    it("should POST a mapping, then DELETE the mapping", done => {
      chai.request(server.app)
        .post("/mappings")
        .set("Authorization", `Bearer ${token}`)
        .send(mapping)
        .end((err, res) => {
          res.should.have.status(201)
          res.body.uri.should.be.a("string")
          let _id = res.body.uri.substring(res.body.uri.lastIndexOf("/") + 1)
          // DELETE
          chai.request(server.app)
            .delete(`/mappings/${_id}`)
            .set("Authorization", `Bearer ${token}`)
            .end((err, res) => {
              res.should.have.status(204)
              // Test if that mapping still exists
              chai.request(server.app)
                .get(`/mappings/${_id}`)
                .set("Authorization", `Bearer ${token}`)
                .end((err, res) => {
                  res.should.have.status(404)
                  done()
                })
            })
        })
    })

  })

  describe("GET /voc", () => {

    it("should GET an empty array", done => {
      chai.request(server.app)
        .get("/voc")
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("0")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(0)
          done()
        })
    })

    it("should GET two vocabularies", done => {
      // Add vocabularies and concepts to database
      cpexec("NODE_ENV=test ./bin/import.js --indexes && NODE_ENV=test ./bin/import.js schemes ./test/terminologies/terminologies.json && NODE_ENV=test ./bin/import.js concepts ./test/concepts/concepts-ddc-6-60-61-62.json", (err) => {
        if (err) {
          done(err)
          return
        }
        chai.request(server.app)
          .get("/voc")
          .end((err, res) => {
            res.should.have.status(200)
            res.should.have.header("Link")
            res.should.have.header("X-Total-Count")
            res.headers["x-total-count"].should.be.eql("2")
            res.body.should.be.a("array")
            res.body.length.should.be.eql(2)
            done()
          })
      })
    })

    it("should support filtering by language", done => {
      chai.request(server.app)
        .get("/voc?languages=fr")
        .end((err, res) => {
          res.body.length.should.be.eql(1)
          done()
        })
    })

    it("should support filtering by multiple languages", done => {
      chai.request(server.app)
        .get("/voc?languages=it,jp,de")
        .end((err, res) => {
          res.body.length.should.be.eql(2)
          done()
        })
    })

    it("should support filtering by license", async () => {
      const res = await chai.request(server.app)
        .get("/voc")
        .query({
          license: "http://creativecommons.org/licenses/by-nc-nd/3.0/",
        })
      assert.strictEqual(res.body.length, 1)
      assert.strictEqual(res.body[0].uri, "http://dewey.info/scheme/edition/e23/")
    })

    it("should support sorting by label", async () => {
      const res = await chai.request(server.app)
        .get("/voc")
        .query({
          sort: "label",
        })
      assert.strictEqual(res.body[0].uri, "http://dewey.info/scheme/edition/e23/")
      assert.strictEqual(res.body[1].uri, "http://bartoc.org/en/node/313")
    })

    it("should support sorting by notation", async () => {
      const res = await chai.request(server.app)
        .get("/voc")
        .query({
          sort: "notation",
        })
      // STW in our test does not have a notation, so it should be on top
      assert.strictEqual(res.body[0].uri, "http://bartoc.org/en/node/313")
      assert.strictEqual(res.body[1].uri, "http://dewey.info/scheme/edition/e23/")
    })

  })

  describe("GET /voc/top", () => {

    it("should GET one top concept", done => {
      chai.request(server.app)
        .get("/voc/top")
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          res.body[0].should.be.a("object")
          res.body[0].uri.should.be.eql("http://dewey.info/class/6/e23/")
          done()
        })
    })

  })

  describe("GET /voc/concepts", () => {

    it("should GET all four concepts", done => {
      chai.request(server.app)
        .get("/voc/concepts")
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("4")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(4)
          res.body[0].should.be.a("object")
          done()
        })
    })

  })

  describe("GET /voc/suggest", () => {

    it("should GET correct results for notation", done => {
      chai.request(server.app)
        .get("/voc/suggest")
        .query({
          search: "dd",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(4) // OpenSearch Suggest Format
          res.body[0].should.be.a("string")
          res.body[1].should.be.a("array")
          res.body[1].length.should.be.eql(1)
          done()
        })
    })

    // TODO: Maybe move somewhere else?
    it("should GET correct results for term (1)", done => {
      chai.request(server.app)
        .get("/voc/suggest")
        .query({
          search: "Thesauru",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(4) // OpenSearch Suggest Format
          res.body[0].should.be.a("string")
          res.body[1].should.be.a("array")
          res.body[1].length.should.be.eql(1)
          done()
        })
    })

    // TODO: Maybe move somewhere else?
    it("should GET correct results for term (2)", done => {
      chai.request(server.app)
        .get("/voc/suggest")
        .query({
          search: "Dewey",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(4) // OpenSearch Suggest Format
          res.body[0].should.be.a("string")
          res.body[1].should.be.a("array")
          res.body[1].length.should.be.eql(1)
          done()
        })
    })

  })

  describe("GET /voc/search", () => {



  })

  describe("GET /data", () => {

    it("should GET empty list when no URL is provided", done => {
      chai.request(server.app)
        .get("/data")
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("0")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(0)
          done()
        })
    })

    it("should GET one concept scheme", done => {
      chai.request(server.app)
        .get("/data")
        .query({
          uri: "http://dewey.info/scheme/edition/e23/",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          res.body[0].should.be.a("object")
          res.body[0].prefLabel.de.should.be.eql("Dewey-Dezimalklassifikation")
          done()
        })
    })

    it("should GET one concept", done => {
      chai.request(server.app)
        .get("/data")
        .query({
          uri: "http://dewey.info/class/61/e23/",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          res.body[0].should.be.a("object")
          res.body[0].prefLabel.de.should.be.eql("Medizin & Gesundheit")
          done()
        })
    })

    it("should GET one concept by notation", done => {
      chai.request(server.app)
        .get("/data")
        .query({
          notation: "61",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          res.body[0].should.be.a("object")
          res.body[0].prefLabel.de.should.be.eql("Medizin & Gesundheit")
          done()
        })
    })

    it("should GET multiple concepts", done => {
      chai.request(server.app)
        .get("/data")
        .query({
          uri: "http://dewey.info/class/60/e23/|http://dewey.info/class/61/e23/",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("2")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(2)
          res.body[0].should.be.a("object")
          res.body[1].should.be.a("object")
          done()
        })
    })

    it("should GET no concepts for different concept scheme", done => {
      chai.request(server.app)
        .get("/data")
        .query({
          uri: "http://dewey.info/class/60/e23/|http://dewey.info/class/61/e23/",
          voc: "http://uri.gbv.de/terminology/bk/",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("0")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(0)
          done()
        })
    })

    it("should GET multiple schemes and concepts by notation", done => {
      chai.request(server.app)
        .get("/data")
        .query({
          notation: "60|61|DDC",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("3")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(3)
          res.body[0].should.be.a("object")
          res.body[1].should.be.a("object")
          res.body[2].should.be.a("object")
          done()
        })
    })

    it("should only GET concepts if voc is given", done => {
      chai.request(server.app)
        .get("/data")
        .query({
          notation: "60|61|DDC",
          voc: "http://dewey.info/scheme/edition/e23/",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("2")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(2)
          res.body[0].should.be.a("object")
          res.body[1].should.be.a("object")
          done()
        })
    })

  })

  describe("GET /narrower", () => {

    it("should GET three children", done => {
      chai.request(server.app)
        .get("/narrower")
        .query({
          uri: "http://dewey.info/class/6/e23/",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("3")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(3)
          done()
        })
    })

  })

  describe("GET /ancestors", () => {

    it("should GET correct results when using properties=narrower", done => {
      chai.request(server.app)
        .get("/ancestors")
        .query({
          uri: "http://dewey.info/class/60/e23/",
          properties: "narrower",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          res.body[0].narrower.should.be.a("array")
          res.body[0].narrower.length.should.be.eql(3)
          done()
        })
    })

  })

  describe("GET /suggest", () => {

    it("should GET correct results for notation", done => {
      chai.request(server.app)
        .get("/suggest")
        .query({
          search: "60",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(4) // OpenSearch Suggest Format
          res.body[0].should.be.a("string")
          res.body[1].should.be.a("array")
          res.body[1].length.should.be.eql(1)
          res.body[1][0].should.be.eql("60 Technik")
          res.body[3].should.be.a("array")
          res.body[3].length.should.be.eql(1)
          res.body[3][0].should.be.eql("http://dewey.info/class/60/e23/")
          done()
        })
    })

    it("should GET correct results for term", done => {
      chai.request(server.app)
        .get("/suggest")
        .query({
          search: "techn",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("2")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(4) // OpenSearch Suggest Format
          res.body[0].should.be.a("string")
          res.body[1].should.be.a("array")
          res.body[1].length.should.be.eql(2)
          res.body[3].should.be.a("array")
          res.body[3].length.should.be.eql(2)
          done()
        })
    })


    it("should GET correct results for term with voc parameter", done => {
      chai.request(server.app)
        .get("/suggest")
        .query({
          search: "techn",
          voc: "http://dewey.info/scheme/edition/e23/",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("2")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(4) // OpenSearch Suggest Format
          res.body[0].should.be.a("string")
          res.body[1].should.be.a("array")
          res.body[1].length.should.be.eql(2)
          res.body[3].should.be.a("array")
          res.body[3].length.should.be.eql(2)
          done()
        })
    })

  })

  describe("GET /search", () => {

    it("should GET correct results for notation", done => {
      chai.request(server.app)
        .get("/search")
        .query({
          search: "60",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          res.body[0].prefLabel.de.should.be.eql("Technik")
          res.body[0].uri.should.be.eql("http://dewey.info/class/60/e23/")
          done()
        })
    })

    it("should GET correct results for term", done => {
      chai.request(server.app)
        .get("/search")
        .query({
          search: "techn",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("2")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(2)
          done()
        })
    })

  })

  describe("/annotations", () => {

    it("should GET zero annotations", done => {
      chai.request(server.app)
        .get("/annotations")
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("0")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(0)
          done()
        })
    })

    let annotation = {
      target: "http://dewey.info/class/60/e23/",
      motivation: "assessing",
      bodyValue: "+1",
    }

    it("should POST a annotation", done => {
      chai.request(server.app)
        .post("/annotations")
        .set("Authorization", `Bearer ${token}`)
        .send(annotation)
        .end((err, res) => {
          res.should.have.status(201)
          res.body.should.be.a("object")
          res.body.id.should.be.a("string")
          // Save id for later use
          annotation.id = res.body.id
          res.body.creator.should.be.eql({ id: user.uri, name: user.name }) // Creator gets decoded from base64
          res.body.target.should.be.eql(annotation.target)
          res.body.motivation.should.be.eql(annotation.motivation)
          res.body.bodyValue.should.be.eql(annotation.bodyValue)
          done()
        })
    })

    it("should not POST an invalid annotation", done => {
      chai.request(server.app)
        .post("/annotations")
        .set("Authorization", `Bearer ${token}`)
        .send(Object.assign({}, annotation, { target: 0 }))
        .end((err, res) => {
          res.should.have.status(422)
          done()
        })
    })

    it("should GET one annotations", done => {
      chai.request(server.app)
        .get("/annotations")
        .end((err, res) => {
          res.should.have.status(200)
          res.should.have.header("Link")
          res.should.have.header("X-Total-Count")
          res.headers["x-total-count"].should.be.eql("1")
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          res.body[0].id.should.be.eql(annotation.id)
          res.body[0]["@context"].should.be.eql("http://www.w3.org/ns/anno.jsonld")
          res.body[0].type.should.be.eql("Annotation")
          done()
        })
    })

    it("should GET an annotation by id", done => {
      let _id = annotation.id.substring(annotation.id.lastIndexOf("/") + 1)
      chai.request(server.app)
        .get("/annotations/" + _id)
        .end((err, res) => {
          res.should.have.status(200)
          res.body.should.be.a("object")
          res.body.id.should.be.eql(annotation.id)
          res.body["@context"].should.be.eql("http://www.w3.org/ns/anno.jsonld")
          res.body.type.should.be.eql("Annotation")
          done()
        })
    })

    it("should not PATCH an annoation unauthorized (1)", done => {
      let _id = annotation.id.substring(annotation.id.lastIndexOf("/") + 1)
      let patch = {
        bodyValue: "-1",
      }
      chai.request(server.app)
        .patch("/annotations/" + _id)
        .send(patch)
        .end((err, res) => {
          res.should.have.status(403)
          done()
        })
    })

    it("should not PATCH an annoation unauthorized (2)", done => {
      let _id = annotation.id.substring(annotation.id.lastIndexOf("/") + 1)
      let patch = {
        bodyValue: "-1",
      }
      chai.request(server.app)
        .patch("/annotations/" + _id)
        .set("Authorization", `Bearer ${tokenWithModerating}`)
        .send(patch)
        .end((err, res) => {
          res.should.have.status(403)
          done()
        })
    })

    it("should not PATCH an annoation that doesn't exist", done => {
      let patch = {
        bodyValue: "-1",
      }
      chai.request(server.app)
        .patch("/annotations/abcdef")
        .set("Authorization", `Bearer ${token}`)
        .send(patch)
        .end((err, res) => {
          res.should.have.status(404)
          done()
        })
    })

    it("should PATCH an annoation", done => {
      let _id = annotation.id.substring(annotation.id.lastIndexOf("/") + 1)
      let patch = {
        bodyValue: "-1",
      }
      chai.request(server.app)
        .patch("/annotations/" + _id)
        .set("Authorization", `Bearer ${token}`)
        .send(patch)
        .end((err, res) => {
          res.should.have.status(200)
          res.body.should.be.a("object")
          res.body.id.should.be.eql(annotation.id)
          res.body.bodyValue.should.not.be.eql(annotation.bodyValue)
          res.body.bodyValue.should.be.eql(patch.bodyValue)
          res.body["@context"].should.be.eql("http://www.w3.org/ns/anno.jsonld")
          res.body.type.should.be.eql("Annotation")
          done()
        })
    })

    it("should PUT an annotation", done => {
      let _id = annotation.id.substring(annotation.id.lastIndexOf("/") + 1)
      let annotation2 = _.clone(annotation)
      annotation2.motivation = "commenting"
      annotation2.bodyValue = "hello"
      chai.request(server.app)
        .put("/annotations/" + _id)
        .set("Authorization", `Bearer ${token}`)
        .send(annotation2)
        .end((err, res) => {
          res.should.have.status(200)
          res.body.should.be.a("object")
          res.body.id.should.be.eql(annotation.id)
          res.body.motivation.should.not.be.eql(annotation.motivation)
          res.body.motivation.should.be.eql(annotation2.motivation)
          res.body.bodyValue.should.not.be.eql(annotation.bodyValue)
          res.body.bodyValue.should.be.eql(annotation2.bodyValue)
          res.body["@context"].should.be.eql("http://www.w3.org/ns/anno.jsonld")
          res.body.type.should.be.eql("Annotation")
          done()
        })
    })

    it("should GET the annotated concept including annotations", done => {
      chai.request(server.app)
        .get("/data")
        .query({
          uri: annotation.target,
          properties: "annotations",
        })
        .end((err, res) => {
          res.should.have.status(200)
          res.body.should.be.a("array")
          res.body.length.should.be.eql(1)
          res.body[0].annotations.should.be.a("array")
          res.body[0].annotations[0].id.should.be.eql(annotation.id)
          res.body[0].annotations[0]["@context"].should.be.eql("http://www.w3.org/ns/anno.jsonld")
          res.body[0].annotations[0].type.should.be.eql("Annotation")
          done()
        })
    })

    it("should DELETE an annotation", done => {
      let _id = annotation.id.substring(annotation.id.lastIndexOf("/") + 1)
      chai.request(server.app)
        .delete("/annotations/" + _id)
        .set("Authorization", `Bearer ${token}`)
        .end((err, res) => {
          res.should.have.status(204)
          done()
        })
    })

    it("should bulk POST annotations properly", done => {
      const annotationToBeUpdated = {
        target: "test:blubb",
        motivation: "assessing",
        bodyValue: "+1",
      }
      const update = { bodyValue: "-1" }
      const bulkAnnotations = [
        // Two empty annotations that are still valid
        {},
        {},
        // One invalid annoation that should be ignored
        {
          target: "test", // target needs to be a URI
        },
      ]
      // 1. Post normal annotation
      chai.request(server.app)
        .post("/annotations")
        .set("Authorization", `Bearer ${token}`)
        .send(annotationToBeUpdated)
        .end((error, res) => {
          res.should.have.status(201)
          res.body.should.be.an("object")
          res.body.id.should.be.a("string")
          assert.notEqual(res.body.bodyValue, update.bodyValue)
          annotationToBeUpdated.id = res.body.id
          let _id = res.body.id.substring(res.body.id.lastIndexOf("/") + 1)
          // Add update to bulk annotations
          bulkAnnotations.push(Object.assign({}, annotationToBeUpdated, update))
          // 2. Post bulk annoations
          chai.request(server.app)
            .post("/annotations")
            .query({
              bulk: true,
            })
            .set("Authorization", `Bearer ${token}`)
            .send(bulkAnnotations)
            .end((error, res) => {
              assert.equal(error, null)
              res.should.have.status(201)
              res.body.should.be.an("array")
              assert.equal(res.body.length, bulkAnnotations.length - 1)
              // 3. Check updated annotation
              chai.request(server.app)
                .get(`/annotations/${_id}`)
                .end((error, res) => {
                  assert.equal(error, null)
                  res.should.have.status(200)
                  res.body.should.be.an("object")
                  assert.equal(res.body.bodyValue, update.bodyValue)
                  done()
                })
            })
        })
    })

    const annotationModerating = {
      target: "http://dewey.info/class/60/e23/",
      motivation: "moderating",
    }

    it("should not POST an annotation with type moderating for user", done => {
      chai.request(server.app)
        .post("/annotations")
        .set("Authorization", `Bearer ${token}`)
        .send(annotationModerating)
        .end((err, res) => {
          res.should.have.status(403)
          res.body.should.be.an("object")
          res.body.error.should.be.eql("ForbiddenAccessError")
          done()
        })
    })

    it("should POST an annotation with type moderating for userWithModerating", done => {
      chai.request(server.app)
        .post("/annotations")
        .set("Authorization", `Bearer ${tokenWithModerating}`)
        .send(annotationModerating)
        .end((err, res) => {
          res.should.have.status(201)
          res.body.should.be.a("object")
          res.body.id.should.be.a("string")
          res.body.creator.should.be.eql({ id: userWithModerating.uri, name: userWithModerating.name }) // Creator gets decoded from base64
          res.body.target.should.be.eql(annotationModerating.target)
          res.body.motivation.should.be.eql(annotationModerating.motivation)
          done()
        })
    })

  })

})
