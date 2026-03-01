import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { config } from "dotenv"
import { createPublicClient, http } from "@arkiv-network/sdk"
import { defineChain } from "viem"

config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 8087
const OWNER_ADDRESS = process.env.ACCOUNT_ADR! as `0x${string}`
const RPC_URL = process.env.RPC_URL!

const mendoza = defineChain({
  id: 60138453056,
  name: "Mendoza",
  network: "mendoza",
  nativeCurrency: {
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [RPC_URL],
    },
  },
  testnet: true,
})

const publicClient = createPublicClient({
  chain: mendoza,
  transport: http(),
})

// RPC semaphore - max 8 concurrent calls to avoid Mendoza rate limiting
const MAX_CONCURRENT_RPC = 8
let activeRpcCalls = 0
const rpcQueue: (() => void)[] = []

function acquireRpc(): Promise<void> {
  if (activeRpcCalls < MAX_CONCURRENT_RPC) {
    activeRpcCalls++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    rpcQueue.push(() => {
      activeRpcCalls++
      resolve()
    })
  })
}

function releaseRpc(): void {
  const next = rpcQueue.shift()
  if (next) {
    next()
  } else {
    activeRpcCalls--
  }
}

// LRU image cache - max 1000 entries
const MAX_IMAGE_CACHE = 1000
const imageCache = new Map<string, Buffer>()

function cacheGet(key: string): Buffer | undefined {
  const value = imageCache.get(key)
  if (value !== undefined) {
    // Move to end (MRU position)
    imageCache.delete(key)
    imageCache.set(key, value)
  }
  return value
}

function cacheSet(key: string, data: Buffer): void {
  if (imageCache.has(key)) {
    imageCache.delete(key)
  } else if (imageCache.size >= MAX_IMAGE_CACHE) {
    // Evict oldest (first) entry
    const oldest = imageCache.keys().next().value!
    imageCache.delete(oldest)
  }
  imageCache.set(key, data)
}

interface ImageMeta {
  key: string
  id: string
  prompt: string
}

// Session cache for pagination results
interface PaginationSession {
  result: any
  currentPage: number
  perPage: number
  createdAt: number
}

const sessionCache = new Map<string, PaginationSession>()
const SESSION_TTL = 5 * 60 * 1000 // 5 minutes

// Cleanup old sessions periodically
setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessionCache) {
    if (now - session.createdAt > SESSION_TTL) {
      sessionCache.delete(id)
    }
  }
}, 60 * 1000)

// Parse entities into ImageMeta
function parseEntities(entities: any[]): ImageMeta[] {
  return entities.map((entity) => {
    const attrs = entity.attributes || []
    return {
      key: entity.key,
      id: String(attrs.find((a: any) => a.key === "id")?.value || ""),
      prompt: String(attrs.find((a: any) => a.key === "prompt")?.value || ""),
    }
  })
}

// Create new pagination session
async function createSession(perPage: number): Promise<{ sessionId: string; images: ImageMeta[]; hasMore: boolean }> {
  const query = publicClient.buildQuery()
  const result = await query
    .ownedBy(OWNER_ADDRESS)
    .withPayload(false)
    .withAttributes(true)
    .orderBy("id", "number", "desc")
    .limit(perPage)
    .fetch()

  const sessionId = randomBytes(8).toString("hex")
  sessionCache.set(sessionId, {
    result,
    currentPage: 1,
    perPage,
    createdAt: Date.now(),
  })

  return {
    sessionId,
    images: parseEntities(result.entities),
    hasMore: result.hasNextPage(),
  }
}

// Get next page from existing session
async function getNextPage(sessionId: string): Promise<{ images: ImageMeta[]; hasMore: boolean } | null> {
  const session = sessionCache.get(sessionId)
  if (!session) return null

  if (!session.result.hasNextPage()) {
    return { images: [], hasMore: false }
  }

  await session.result.next()
  session.currentPage++
  session.createdAt = Date.now() // Refresh TTL

  return {
    images: parseEntities(session.result.entities),
    hasMore: session.result.hasNextPage(),
  }
}

// Fetch single image by key with cache, semaphore, and retry
const MAX_RETRIES = 2

async function fetchImage(key: string): Promise<Buffer | null> {
  const cached = cacheGet(key)
  if (cached) return cached

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await acquireRpc()
    try {
      const entity = await publicClient.getEntity(key)
      if (entity?.payload) {
        const data = Buffer.from(entity.payload)
        cacheSet(key, data)
        return data
      }
      return null
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.warn(`fetchImage retry ${attempt}/${MAX_RETRIES} for ${key}:`, error)
        await new Promise((r) => setTimeout(r, 200 * attempt))
      } else {
        console.error(`fetchImage failed after ${MAX_RETRIES} attempts for ${key}:`, error)
        return null
      }
    } finally {
      releaseRpc()
    }
  }
  return null
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`)

  // List of images with SDK pagination
  if (url.pathname === "/api/images") {
    try {
      const sessionId = url.searchParams.get("sessionId")
      const limitParam = url.searchParams.get("limit")
      const perPage = limitParam ? Math.min(parseInt(limitParam), 200) : 50

      if (sessionId) {
        // Continue existing session
        const pageData = await getNextPage(sessionId)
        if (!pageData) {
          res.writeHead(404, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Session not found or expired" }))
          return
        }

        console.log(`Session ${sessionId}: ${pageData.images.length} images, hasMore: ${pageData.hasMore}`)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          images: pageData.images,
          sessionId,
          hasMore: pageData.hasMore,
        }))
      } else {
        // New session
        const { sessionId: newSessionId, images, hasMore } = await createSession(perPage)

        console.log(`New session ${newSessionId}: ${images.length} images, hasMore: ${hasMore}`)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          images,
          sessionId: newSessionId,
          hasMore,
        }))
      }
    } catch (error) {
      console.error("Error fetching images:", error)
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Failed to fetch images" }))
    }
    return
  }

  // Single image by key
  if (url.pathname === "/api/image") {
    const key = url.searchParams.get("key")
    if (!key) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Missing key parameter" }))
      return
    }
    try {
      const imageData = await fetchImage(key)
      if (imageData) {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": imageData.length.toString(),
          "Cache-Control": "public, max-age=86400",
        })
        res.end(imageData)
      } else {
        res.writeHead(404)
        res.end("Image not found")
      }
    } catch (error) {
      console.error("Error fetching image:", error)
      res.writeHead(500)
      res.end("Error fetching image")
    }
    return
  }

  // Serve HTML
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = await readFile(join(__dirname, "public", "index.html"), "utf-8")
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(html)
    } catch {
      res.writeHead(404)
      res.end("Not found")
    }
    return
  }

  res.writeHead(404)
  res.end("Not found")
}

const server = createServer(handleRequest)

server.listen(PORT, () => {
  console.log(`Arkiv Image Viewer running at http://localhost:${PORT}`)
  console.log(`Owner: ${OWNER_ADDRESS}`)
})
