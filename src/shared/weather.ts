import type mysql from 'mysql2/promise'
import { safeGet, safeSetEx } from './redis'

// Open-Meteo — free, no API key, generous rate limits. Two endpoints:
//   Geocoding — resolve suburb+state to lat/lon (rarely changes; cache 30 days)
//   Forecast  — daily weather for a lat/lon (refresh every 30 min)

interface GeoResult { lat: number; lon: number; name: string; admin1: string }

export async function geocodeSuburb(suburb: string, state: string | null): Promise<GeoResult | null> {
  if (!suburb) return null
  const key    = `geo:au:${suburb.toLowerCase()}:${(state ?? '').toLowerCase()}`
  const cached = await safeGet<GeoResult>(key)
  if (cached) return cached

  // Open-Meteo's `country` param is unreliable; filter client-side by country_code.
  const q   = encodeURIComponent(suburb)
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=10&language=en&format=json`
  try {
    const res  = await fetch(url)
    if (!res.ok) return null
    const json: any = await res.json()
    const auResults = ((json?.results ?? []) as any[]).filter(r => r.country_code === 'AU')
    if (!auResults.length) return null
    // Prefer the result whose admin1 matches the customer's state (VIC → Victoria, etc.)
    const stateFull: Record<string, string> = {
      VIC: 'Victoria', NSW: 'New South Wales', QLD: 'Queensland', SA: 'South Australia',
      WA: 'Western Australia', TAS: 'Tasmania', NT: 'Northern Territory', ACT: 'Australian Capital Territory',
    }
    const wanted = state ? (stateFull[state.toUpperCase()] ?? state) : null
    const pick   = (wanted ? auResults.find(r => r.admin1 === wanted) : null) ?? auResults[0]
    const geo: GeoResult = { lat: pick.latitude, lon: pick.longitude, name: pick.name, admin1: pick.admin1 }
    await safeSetEx(key, 30 * 24 * 3600, geo)  // 30 days — suburbs don't move
    return geo
  } catch {
    return null
  }
}

export interface DailyForecast {
  date:                     string      // YYYY-MM-DD
  weekday:                  string      // "Wed"
  tempMinC:                 number
  tempMaxC:                 number
  precipitationMm:          number
  precipitationProbability: number      // 0-100
  condition:                string      // one-word summary
}

// WMO weather code → short label. Reference: https://open-meteo.com/en/docs
function conditionFor(code: number): string {
  if (code === 0)                     return 'clear'
  if (code >= 1  && code <= 3)        return 'partly cloudy'
  if (code === 45 || code === 48)     return 'fog'
  if (code >= 51 && code <= 57)       return 'drizzle'
  if (code >= 61 && code <= 65)       return 'rain'
  if (code >= 66 && code <= 67)       return 'freezing rain'
  if (code >= 71 && code <= 77)       return 'snow'
  if (code >= 80 && code <= 82)       return 'showers'
  if (code >= 85 && code <= 86)       return 'snow showers'
  if (code >= 95 && code <= 99)       return 'thunderstorm'
  return 'unknown'
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export async function getForecast(lat: number, lon: number, days: number): Promise<DailyForecast[]> {
  const key    = `wx:${lat.toFixed(2)}:${lon.toFixed(2)}:${days}`
  const cached = await safeGet<DailyForecast[]>(key)
  if (cached) return cached

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
            + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max`
            + `&timezone=Australia%2FSydney&forecast_days=${Math.min(Math.max(days, 1), 7)}`
  try {
    const res  = await fetch(url)
    if (!res.ok) return []
    const json: any = await res.json()
    const d = json?.daily
    if (!d?.time?.length) return []
    const forecasts: DailyForecast[] = d.time.map((iso: string, i: number) => {
      const dt = new Date(`${iso}T00:00:00`)
      return {
        date:                     iso,
        weekday:                  WEEKDAY[dt.getDay()],
        tempMinC:                 Math.round(Number(d.temperature_2m_min[i])),
        tempMaxC:                 Math.round(Number(d.temperature_2m_max[i])),
        precipitationMm:          Math.round(Number(d.precipitation_sum[i]) * 10) / 10,
        precipitationProbability: Number(d.precipitation_probability_max[i] ?? 0),
        condition:                conditionFor(Number(d.weather_code[i])),
      }
    })
    await safeSetEx(key, 1800, forecasts)  // 30 min
    return forecasts
  } catch {
    return []
  }
}

// Convenience wrapper for endpoints that just want "the customer's weather".
// Returns null if customer has no suburb on file OR geocoding fails.
export async function getCustomerWeather(
  db:         mysql.Pool,
  customerId: number,
  days:       number = 3,
): Promise<{ location: string; forecast: DailyForecast[] } | null> {
  const [[cust]] = await db.query<any[]>(
    'SELECT suburb, state FROM customers WHERE id = ? LIMIT 1',
    [customerId],
  )
  if (!cust?.suburb) return null

  const geo = await geocodeSuburb(String(cust.suburb), cust.state ? String(cust.state) : null)
  if (!geo) return null

  const forecast = await getForecast(geo.lat, geo.lon, days)
  if (!forecast.length) return null

  return { location: `${geo.name}, ${geo.admin1}`, forecast }
}

// Compact one-line summary suitable for greeting snapshots.
// Example: "Somerville: clear today (7-16°C), showers Thu (5mm), thunderstorm Fri."
export function summariseForecast(location: string, forecast: DailyForecast[]): string {
  if (!forecast.length) return ''
  const days = forecast.map(f => {
    const wet = f.precipitationProbability >= 60 || f.precipitationMm >= 5
    if (wet) return `${f.weekday} ${f.condition} (${f.precipitationMm}mm)`
    if (f.tempMaxC >= 35) return `${f.weekday} hot ${f.tempMaxC}°C`
    if (f.tempMinC <= 2)  return `${f.weekday} cold ${f.tempMinC}°C low`
    return `${f.weekday} ${f.condition}`
  })
  return `${location}: ${days.join(', ')}.`
}
