import type { AgentType } from './types'

export function classifyIntent(message: string, isPremium: boolean): AgentType {
  const m = message.toLowerCase()

  if (/\b(book|booking|appointment|schedule|available|availability|when can i|come in|bring.{0,10}in|drop.{0,5}off|service date|loan car|courtesy car|organise.{0,10}service)\b/.test(m)) {
    return 'booking'
  }

  if (isPremium) {
    if (/\b(fuel price|petrol price|diesel price|cheapest fuel|cheapest petrol|fuel near|servo near|cheapest near|price.{0,10}litre|station near|where.{0,10}cheap)\b/.test(m)) {
      return 'fuel'
    }

    if (/\b(expenses?|spending|how much.{0,20}spent|how much.{0,20}costs?|receipts?|running costs?|annual costs?|yearly costs?|tax export|business expense|fuel efficiency|litres per|l\/100|cost per km|fuel costs?|fuel spend|fuel expenses?|tracking costs?|what.{0,15}costs?|my costs?)/.test(m)) {
      return 'expense'
    }

    if (/\b(logbook|import.{0,10}invoice|old invoice|previous.{0,10}workshop|other workshop|past service|maintenance record)\b/.test(m)) {
      return 'logbook'
    }
  }

  return 'vehicle'
}
