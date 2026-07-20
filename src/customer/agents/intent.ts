import type { AgentType } from './types'

export function classifyIntent(message: string, isPremium: boolean): AgentType {
  const m = message.toLowerCase()

  // ── CONVERSATION RECALL: keep in the main handler which has
  //    getDiagnosticHistory + getSessionMessages. Otherwise a message like
  //    "Vehicle Expense Tracker Chat- July 13" (referring to a prior session
  //    by title) would route to the expense agent and fail to recall.
  if (
    /\b(previous|past|old|earlier|last).{0,10}(conversation|conversations|chat|chats|session|sessions|discussion|discussions)\b/.test(m) ||
    /\b(chat|conversation|session|discussion)\s+history\b/.test(m) ||
    /\b(recall|remember).{0,25}(our|the|previous|earlier|last).{0,15}(conversation|chat|discussion|talk)\b/.test(m) ||
    /\bwhat.{0,15}(we|you).{0,15}(discuss|discussed|talk|talked|say|said|mention|mentioned)\b/.test(m) ||
    /\b(all|list).{0,15}(our|my|the).{0,15}(conversation|conversations|chat|chats|session|sessions)\b/.test(m) ||
    // Session-title reference — user is quoting a title from getDiagnosticHistory.
    // Titles typically end in "chat/session/support" and may be followed by a
    // date ("Chat- July 13", "Chat from July 13", "Chat on 2026-07-13").
    /\b(chat|session|support)\b.{0,25}(-|–|—|from|on|dated|of)\s*.{0,15}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|20\d{2})/i.test(m) ||
    // "tell me about the X chat" / "detail the X chat"
    /\b(tell|show|detail|open).{0,25}(the|that|our).{0,30}(chat|conversation|session)\b/.test(m)
  ) {
    return 'vehicle'
  }

  // ── VEHICLE PRE-CHECKS: safety / diagnostic questions always go to vehicle ──
  // Must run before booking so "safe to drive with worn brake pad" isn't misrouted
  if (
    /\b(is it safe|is this safe|should i (still )?drive|safe to drive)\b/.test(m) ||
    /\b(safe|unsafe|okay|ok|dangerous|risk(y)?).{0,20}(drive|driving|brake|worn|damaged|leaking|low|flat)\b/.test(m) ||
    /\bcan i (still )?drive.{0,30}(brake|oil|tyre|light|coolant|warning|leak|noise)\b/.test(m) ||
    /\b(warning.{0,5}light|check.{0,5}engine|dashboard.{0,5}light|oil.{0,5}light|engine.{0,5}light)\b/.test(m) ||
    /\b(error.{0,5}code|obd.{0,5}code|fault.{0,5}code|p0[0-9]{3})\b/.test(m)
  ) {
    return 'vehicle'
  }

  // ── LOGBOOK PRE-CHECKS: unambiguous history signals (run before booking) ──
  // "full service history" would otherwise match booking's "full service" pattern
  if (
    /\b(service|maintenance|repair).{0,10}(history|records?|log)\b/.test(m) ||
    /\bwhen.{0,10}was.{0,30}(last|previous|the.{0,5}last)\b/.test(m) ||
    /\bhow.{0,10}long.{0,10}(ago|since).{0,20}(service|oil|fix|repair|check|work)\b/.test(m) ||
    /\b(full|complete|all|entire).{0,10}(service|maintenance|repair).{0,10}(history|records?|log)\b/.test(m) ||
    /\bservice.{0,5}log\b/.test(m) ||
    /\b(show|view|see|get).{0,10}(my.{0,5})?logbook\b/.test(m) ||
    /\bmy\s+logbook\b/.test(m)
  ) {
    return 'logbook'
  }

  // ── QUOTE (before booking so "explain the quote" doesn't hit service regexes) ──
  // The customer is asking about a quote we already sent them. Route to the
  // quote agent so it can pull the actual line items + voice notes and
  // explain in the "educate don't sell" voice. NOT for the initial "how much
  // does a service cost" question — that's a general vehicle Q&A.
  if (
    /\b(the|this|my|our|that|latest|recent|last)\s+quote\b/.test(m) ||
    /\bquote\s+(you|rodz)\s+sent\b/.test(m) ||
    /\bexplain.{0,20}\bquote\b/.test(m) ||
    /\b(understand|walk|talk).{0,15}(me\s+)?through.{0,15}(the\s+)?quote\b/.test(m) ||
    /\b(what|which|why).{0,25}(item|items|line|lines|part|parts)\s.{0,20}\bquote\b/.test(m) ||
    /\bquote\b.{0,25}(item|items|line|lines|break.?down|breakdown)\b/.test(m) ||
    /\bquote\s+(number|ref|reference)\b/.test(m) ||
    /\bq\d{3,}\b/i.test(m) ||
    /\b(accept|approve|reject|decline).{0,20}\b(item|items|line|lines)\b/.test(m) ||
    /\b(voice|audio|memo)\s+(note|notes|message)\b/.test(m) && /\bquote\b/.test(m)
  ) {
    return 'quote'
  }

  // ── BOOKING ──────────────────────────────────────────────────────────────
  if (
    // Core booking intent
    /\b(book(ing)?s?|appointment|schedule[d]?|slots?|spots?|openings?)\b/.test(m) ||
    /\bsqueeze.{0,8}me.{0,8}in\b/.test(m) ||
    /\b(come.{0,10}in|bring.{0,10}in|drop.{0,8}off|drop.{0,8}car|pick.{0,8}up)\b/.test(m) ||
    /bring.{0,15}(it|car|vehicle|ute|truck|van).{0,15}in/.test(m) ||
    /drop.{0,15}(it|car|vehicle|ute|truck|van).{0,15}(off|in)/.test(m) ||
    /come.{0,15}(in|by|around|over).{0,10}(for|to)/.test(m) ||

    // Availability
    /\b(available|availability)\b/.test(m) ||
    /\bwhen.{0,10}\b(can|could)\b/.test(m) ||
    /\b(fit.{0,8}me|fit.{0,8}(us|it)|fit.{0,10}(new|my))\b/.test(m) ||
    /\bnext.{0,10}(time|slot|available)\b/.test(m) ||

    // Loan / courtesy car
    /\b(loan.{0,6}cars?|courtesy.{0,6}cars?|hire.{0,6}cars?|replacement.{0,6}cars?|loaner)\b/.test(m) ||

    // Safety inspections
    /\b(roadworthy|rwc|pink.?slip|blue.?slip)\b/.test(m) ||
    /\bsafety.{0,10}certif/.test(m) ||
    /\b(rego|registration).{0,10}(check|inspect|certif)/.test(m) ||

    // Service overdue / due checks
    /\b(overdue|due).{0,15}(service|oil|inspection)\b/.test(m) ||
    /\bservice.{0,20}(is.{0,5})?overdue\b/.test(m) ||
    /\bhow.{0,10}long.{0,10}(until|till|before|to).{0,15}service\b/.test(m) ||
    /\bwhen.{0,10}\b(should i|would i|do i|am i)\b.{0,20}service[d]?\b/.test(m) ||
    /\bwhen.{0,10}\b(should i|would i|do i|am i)\b.{0,20}(bring|come|book)\b/.test(m) ||

    // Organising
    /\b(organis|arrang|make).{0,10}(service|appointment|booking)\b/.test(m) ||

    // Tyres (as a job)
    /\btyre.{0,10}(fit|swap|change|rotat|balanc|check)/.test(m) ||
    /\bfit.{0,10}(new.{0,5})?tyres?\b/.test(m) ||
    /\bwheel.{0,10}(align|balanc|rotat|swap)/.test(m) ||

    // Service types
    /\b(oil.{0,10}(change|service|due)|logbook.{0,10}service)\b/.test(m) ||
    /\b(interim|major|minor|full).{0,10}service\b/.test(m) ||

    // Specific mechanical jobs (as work to book)
    /\bbrake.{0,10}(pad|service|replac|bleed)s?\b/.test(m) ||
    /\bnew.{0,10}brake.{0,10}pads?\b/.test(m) ||
    /\b(timing.{0,6}belt|timing.{0,6}chain)\s*(replacement|replac)\b/.test(m) ||
    /\bbattery.{0,10}(replac|change|swap|new)/.test(m) ||
    /\bnew.{0,10}battery\b/.test(m) ||
    /\b(air|cabin|fuel).{0,5}filter.{0,10}(change|replac|clean)/.test(m) ||
    /\bspark.{0,5}plug.{0,10}(replac|change|new)/.test(m) ||
    /\bnew.{0,10}spark.{0,5}plugs?\b/.test(m) ||
    /\bcoolant.{0,10}(flush|change|replac)\b/.test(m) ||
    /\b(gearbox|transmission).{0,10}(service|flush|fluid|oil)\b/.test(m) ||
    /\bdiff.{0,10}(service|fluid|oil|flush)\b/.test(m)
  ) {
    return 'booking'
  }

  // ── FUEL PRICES (premium) ─────────────────────────────────────────────────
  if (isPremium && (
    /\b(fuel|petrol|diesel|unleaded|e10|lpg).{0,10}prices?\b/.test(m) ||
    /\bprice.{0,10}(litre|liter|per.?l)\b/.test(m) ||
    /\bprice.{0,10}(for|of).{0,10}(95|91|98|e10|diesel|unleaded)\b/.test(m) ||
    /\bcheapest.{0,20}(fuel|petrol|diesel|unleaded|servo|station|pump|91|95|98|e10|octane|premium)\b/.test(m) ||
    /\b(fill.{0,10}up|refuel|top.{0,5}up).{0,20}(near|cheap|cheapest|around|where)\b/.test(m) ||
    /\bwhere.{0,20}(cheap|cheapest|best.{0,8}price|fill.{0,8}up|refuel)\b/.test(m) ||
    /\b(current|today.?s?).{0,10}(fuel|petrol|diesel|unleaded)\b/.test(m) ||
    /\bhow.{0,10}much.{0,15}(petrol|diesel|unleaded|fuel).{0,20}(cost|near|today|litre|liter)\b/.test(m) ||
    /\bfuel.{0,20}(going|getting).{0,10}(up|down|cheap|expens|higher|lower)\b/.test(m) ||
    /\b(is|are).{0,10}(petrol|diesel|fuel|unleaded).{0,20}(going|getting|risen|fallen|up|down|cheap|expens)\b/.test(m) ||
    /\b(petrol|fuel|gas).{0,5}station\b/.test(m) ||
    /\b(nearest|closest|nearby|near).{0,10}(servo|fuel|petrol|station)\b/.test(m) ||
    /\bservo.{0,10}(near|around|close|by)\b/.test(m) ||
    /\bbest.{0,10}servo\b/.test(m) ||
    /\bbest.{0,10}price.{0,20}(fuel|petrol|diesel|unleaded|95|91|98|e10)\b/.test(m) ||
    /\bfuel.{0,10}trend\b/.test(m) ||
    /\bpump.{0,10}price\b/.test(m) ||
    /\b(bp|shell|ampol|coles.{0,8}express|woolworths.{0,8}fuel|7.?eleven|united|liberty|puma|viva).{0,40}(cheap|cheaper|price|fuel|petrol|diesel)\b/.test(m) ||
    /\b(cheap|cheaper|price|fuel|petrol|diesel).{0,40}(bp|shell|ampol|7.?eleven|united|liberty|puma|viva)\b/.test(m)
  )) {
    return 'fuel'
  }

  // ── EXPENSES (premium) ────────────────────────────────────────────────────
  if (isPremium && (
    /\b(expenses?|spending|spent|expenditure)\b/.test(m) ||
    /\b(running|annual|yearly|overall|total).{0,10}costs?\b/.test(m) ||
    /\bhow.{0,10}much.{0,30}(spent?|cost|spend|pay|paid)\b/.test(m) ||
    /\bwhat.{0,20}(did.{0,5}i|have.{0,5}i).{0,15}(spend|spent|pay|paid)\b/.test(m) ||
    /\bhow.{0,10}much.{0,10}(is|does|has).{0,10}(it|this|the.{0,5}car).{0,10}(cost|costing|costs)\b/.test(m) ||
    /\b(show|view).{0,10}(my.{0,5})?receipts?\b/.test(m) ||
    /\bmy\s+receipts?\b/.test(m) ||
    /\breceipt.{0,10}history\b/.test(m) ||
    /\b(fuel|petrol).{0,10}(costs?|expenses?|spending|spend|total|bill)\b/.test(m) ||
    /\b(service|maintenance|repair).{0,10}(costs?|expenses?|total|spending)\b/.test(m) ||
    /\bcost.{0,10}(this|last|per).{0,10}(year|month|week)\b/.test(m) ||
    /\b(tax|ato).{0,10}(export|deduct|return|report|claim)\b/.test(m) ||
    /\bexport.{0,10}(tax|csv|report|expenses?)\b/.test(m) ||
    /\bbusiness.{0,10}(expense|deduct|claim|use)\b/.test(m) ||
    /\b(vehicle|car).{0,15}deductions?\b/.test(m) ||
    /\bwork.{0,10}vehicle.{0,10}deductions?\b/.test(m) ||
    /\bwork.{0,10}(expense|deduct)\b/.test(m) ||
    /\bfuel.{0,10}(efficienc|consum|usage|economy)/.test(m) ||
    /\b(litres?.{0,10}per|l\/.{0,5}100|km.{0,10}per.{0,10}litre|cost.{0,10}per.{0,10}km)\b/.test(m) ||
    /\b(monthly|weekly|average).{0,10}(cost|spend|expense)\b/.test(m) ||
    /\b(most.{0,10}(expensive|costly)|biggest.{0,10}(expense|cost))\b/.test(m) ||
    /\bwhere.{0,15}(money|spending|spend)\b/.test(m) ||
    /\b(tracking|track).{0,10}costs?\b/.test(m) ||
    /\bmy.{0,10}costs?\b/.test(m)
  )) {
    return 'expense'
  }

  // ── LOGBOOK / SERVICE HISTORY ─────────────────────────────────────────────
  if (
    // History queries
    /\b(all|every).{0,10}services?\b/.test(m) ||
    /\bwhat.{0,15}(done|been.{0,10}done|was.{0,10}done|work|repairs?|services?|fixed|repaired).{0,20}(on|to|for|at).{0,10}(car|vehicle|it)\b/.test(m) ||
    /\bwhat.{0,10}(did.{0,10}(they|you|rodz)|was.{0,10}(done|replaced|changed|fixed)).{0,20}(at|during|in|on|last|time)\b/.test(m) ||
    /\b(repairs?|work|services?).{0,20}(been.{0,10}done|done|had|completed|carried.{0,5}out)\b/.test(m) ||
    /\b(any|some).{0,15}(work|service|repair).{0,15}(done|completed|carried|performed|before|previous)\b/.test(m) ||
    /\bwas.{0,15}(work|service|repairs?|anything).{0,15}(done|completed|performed|previously)\b/.test(m) ||

    // When questions (past-tense)
    /\bwhen.{0,15}(last|previously|was.{0,10}it|did.{0,10}(i|you|they)).{0,20}(service|serviced|oil|work|done|check)\b/.test(m) ||

    // Who / where serviced (note: service[d]? to handle "serviced")
    /\b(who|which.{0,5}(mechanic|workshop|garage|tech)).{0,20}(service[d]?|fix|repair|did.{0,5}the.{0,5}work)\b/.test(m) ||
    /\bwhere.{0,20}(was|is|has.{0,5}it.{0,5}been).{0,20}(service[d]?|fixed|repaired|worked.{0,5}on)\b/.test(m) ||

    // Last service references
    /\b(last|previous).{0,10}(service|oil.{0,5}change|repair|fix|visit|workshop)\b/.test(m) ||

    // Import / add external records
    /\b(import|add|scan|upload|photograph).{0,15}(old|past|previous|another|external).{0,10}(invoice|receipt|service|record)\b/.test(m) ||
    /\b(invoice|receipt).{0,15}(from|at|another|other|different|old|previous|past).{0,15}(mechanic|workshop|garage|repairer|dealer)\b/.test(m) ||
    /\b(old|past|previous|another|other|different).{0,15}(mechanic|workshop|garage|repairer|dealer)\b/.test(m) ||
    /\b(went|go|been|used).{0,15}(another|other|different|a.{0,5}different|a.{0,5}other).{0,15}(mechanic|workshop|garage|repairer)\b/.test(m) ||

    // Frequency / intervals
    /\b(how.{0,10}many.{0,10}times|how.{0,10}often|number.{0,10}of.{0,10}services?).{0,15}serviced\b/.test(m) ||
    /\bkm.{0,10}(since|between|from|to).{0,10}(last|each|services?)\b/.test(m) ||
    /\b(kilometres?|km|k).{0,10}(since|between|ago).{0,15}(service|oil|work)\b/.test(m) ||
    /\bhow.{0,10}far.{0,10}(since|between|ago|from|to).{0,15}(service|oil|work|last)\b/.test(m)
  ) {
    return 'logbook'
  }

  return 'vehicle'
}
