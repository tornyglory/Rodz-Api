import type mysql from 'mysql2/promise'
import type { Content } from '@google/generative-ai'

export type AgentType = 'booking' | 'vehicle' | 'expense' | 'fuel' | 'logbook'

export interface AgentContext {
  db:                mysql.Pool
  customerId:        number
  vehicleId:         number
  vehicleRego:       string
  customerFirstName: string | null
  customerSuburb:    string | null
  customerState:     string | null
  isPremium:         boolean
  vehicleContext:    string
  history:           Content[]
  today:             string
}

export interface AgentResult {
  content:       string
  functionCalls: { name: string; args: any; result: object }[]
}
