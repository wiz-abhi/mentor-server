import { sql } from "@vercel/postgres"
import 'dotenv/config'

// Helper function to execute SQL queries
export async function query(text: string, params?: any[]) {
  try {
    const result = await sql.query(text, params || [])
    return result
  } catch (error) {
    console.error("Error executing query", { text, error })
    throw error
  }
}

