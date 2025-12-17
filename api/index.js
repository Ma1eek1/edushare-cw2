const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ---- Config from Environment Variables ----
const {
  COSMOS_ENDPOINT,
  COSMOS_KEY,
  COSMOS_DATABASE = "edushare",
  COSMOS_CONTAINER = "assets",
  BLOB_CONNECTION_STRING,
  BLOB_CONTAINER = "uploads",
  PORT = 8080,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

requireEnv("COSMOS_ENDPOINT", COSMOS_ENDPOINT);
requireEnv("COSMOS_KEY", COSMOS_KEY);
requireEnv("BLOB_CONNECTION_STRING", BLOB_CONNECTION_STRING);

// ---- Clients ----
const cosmos = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
const container = cosmos.database(COSMOS_DATABASE).container(COSMOS_CONTAINER);

const blobService = BlobServiceClient.fromConnectionString(BLOB_CONNECTION_STRING);
const blobContainer = blobService.getContainerClient(BLOB_CONTAINER);

// ---- File upload setup (memory) ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ---- Helpers ----
function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function safeVisibility(v) {
  const vis = (v || "private").toLowerCase();
  if (!["public", "private"].includes(vis)) return "private";
  return vis;
}

// ---- Health ----
app.get("/", (req, res) => res.send("EduShare API running"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ---- CREATE (upload + metadata) ----
// POST /files  (multipart/form-data: file, title, visibility)
app.post("/files", upload.single("file"), async (req, res) => {
  try {
    const visibility = safeVisibility(req.body.visibility);
    const title = (req.body.title || req.file?.originalname || "Untitled").trim();

    if (!req.file) return res.status(400).json({ error: "Missing file" });

    // Ensure container exists (safe if already exists)
    await blobContainer.createIfNotExists();

    const id = makeId();
    const blobName = `${id}-${req.file.originalname}`.replace(/\s+/g, "_");
    const blockBlob = blobContainer.getBlockBlobClient(blobName);

    await blockBlob.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    const doc = {
      id,
      visibility,               // IMPORTANT: partition key = /visibility
      title,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      blobName,
      blobUrl: blockBlob.url,   // will work; if container is private, URL needs SAS later
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await container.items.create(doc);

    res.status(201).json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// ---- READ ALL ----
// GET /files?visibility=public|private
app.get("/files", async (req, res) => {
  try {
    const visibility = req.query.visibility ? safeVisibility(req.query.visibility) : null;

    const query = visibility
      ? { query: "SELECT * FROM c WHERE c.visibility = @v ORDER BY c.createdAt DESC", parameters: [{ name: "@v", value: visibility }] }
      : { query: "SELECT * FROM c ORDER BY c.createdAt DESC" };

    const { resources } = await container.items.query(query).fetchAll();
    res.json(resources);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to list files" });
  }
});

// ---- READ ONE ----
// GET /files/:id?visibility=public|private   (visibility REQUIRED for partitioned read)
app.get("/files/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const visibility = safeVisibility(req.query.visibility);

    const { resource } = await container.item(id, visibility).read();
    if (!resource) return res.status(404).json({ error: "Not found" });

    res.json(resource);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to get file" });
  }
});

// ---- UPDATE METADATA ----
// PUT /files/:id  JSON body: { visibility, title }
// NOTE: If you change visibility, it becomes a NEW item in a different partition.
// To keep it simple for demo: we DO NOT allow visibility change (title-only update).
app.put("/files/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const visibility = safeVisibility(req.body.visibility || req.query.visibility); // must match existing partition key
    const newTitle = (req.body.title || "").trim();

    if (!visibility) return res.status(400).json({ error: "visibility required" });

    const { resource } = await container.item(id, visibility).read();
    if (!resource) return res.status(404).json({ error: "Not found" });

    if (newTitle) resource.title = newTitle;
    resource.updatedAt = new Date().toISOString();

    const { resource: updated } = await container.item(id, visibility).replace(resource);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to update file" });
  }
});

// ---- DELETE ----
// DELETE /files/:id?visibility=public|private
app.delete("/files/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const visibility = safeVisibility(req.query.visibility);
    if (!visibility) return res.status(400).json({ error: "visibility required" });

    // read doc to get blobName for cleanup
    const { resource } = await container.item(id, visibility).read();
    if (!resource) return res.status(404).json({ error: "Not found" });

    // delete cosmos first
    await container.item(id, visibility).delete();

    // delete blob
    if (resource.blobName) {
      const blobClient = blobContainer.getBlockBlobClient(resource.blobName);
      await blobClient.deleteIfExists();
    }

    res.json({ deleted: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to delete file" });
  }
});

app.listen(PORT, () => console.log(`EduShare API listening on ${PORT}`));