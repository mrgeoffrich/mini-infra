import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app: express.Application = express()

// Middleware
app.use(cors())
app.use(express.json())

// API routes
//app.use('/api', apiRoutes)

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error(err.stack)
    res.status(500).json({ error: 'Something went wrong!' })
})

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../public')))

    // Handle client-side routing
    app.get('*', (req: Request, res: Response) => {
        res.sendFile(path.join(__dirname, '../public/index.html'))
    })
}

export default app