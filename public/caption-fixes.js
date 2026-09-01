/* --------------------------------------------------------------------
 * Caption corrections.
 *
 * Speech recognition has no custom vocabulary -- Chrome ignores
 * SpeechGrammarList -- so COSC264 terminology comes back wrong in three ways.
 *
 *   1. Acronyms arrive with no word boundaries: "CIDRNAPTOSPF".
 *      The letters are right, so they can be segmented mechanically.
 *
 *   2. Phrases misfire phonetically but consistently: "Bellman-Ford" came
 *      back as Bowman Ford / Belmont Ford / Bowman Fort / Belford and was
 *      never once correct. Consistency is what makes it fixable.
 *
 *   3. Notation is not words at all. d_s(v) is dictated as "d sub s of v",
 *      and the letters come back as English -- u is "you", v is "we". Those
 *      are only recoverable next to an anchor that ordinary speech does not
 *      use, which is what "sub", "node" and "router" are for below.
 *
 * Loaded by the decks and applied by deck-remote.js as each chunk arrives, so
 * the projecting machine has the last word on what appears and the table can
 * change without the phone reloading anything.
 *
 * Vocabulary source: docs/caption-vocabulary-module1.md
 * ------------------------------------------------------------------ */
(() => {
  'use strict';

  // Longest first: the segmenter is greedy and HTTPS must beat HTTP.
  const ACRONYMS = [
    'HTTPS', 'ICMP', 'OSPF', 'NAPT', 'CIDR', 'IBGP', 'EBGP', 'HTTP',
    'DHCP', 'IPV4', 'IPV6', 'SMTP', 'IMAP', 'POP3', 'LSDB', 'DNS', 'BGP',
    'TCP', 'UDP', 'ARQ', 'CRC', 'MAC', 'LAN', 'WAN', 'MTU', 'TTL', 'ARP',
    'NAT', 'RIP', 'ACK', 'NAK', 'RTT', 'ISP', 'URL', 'LSA', 'ASN', 'IGP',
    'EGP', 'IP', 'AS',
  ];

  // How each acronym should finally appear.
  const CASING = { IBGP: 'iBGP', EBGP: 'eBGP', IPV4: 'IPv4', IPV6: 'IPv6', POP3: 'POP3' };
  const cased = a => CASING[a] || a;

  /* ------------------------------------------------------------------
   * Spoken letter names.
   *
   * Recognised speech turns single letters into ordinary English: u is
   * "you", v is "we" or "be", y is "why", q is "cue", s is "as". Rewriting
   * those globally would wreck every normal sentence, so this table is
   * consulted ONLY inside an anchored pattern -- after the word "sub", or
   * after "node" or "router". Inside those, "you" is certainly the letter u;
   * everywhere else it is left alone.
   * ---------------------------------------------------------------- */
  const LETTER = {
    a: 'a', ay: 'a', eh: 'a',
    b: 'b', bee: 'b', be: 'b',
    c: 'c', cee: 'c', see: 'c', sea: 'c',
    d: 'd', dee: 'd',
    e: 'e', ee: 'e',
    f: 'f', ef: 'f', eff: 'f',
    g: 'g', gee: 'g',
    h: 'h', aitch: 'h',
    i: 'i',
    j: 'j', jay: 'j',
    k: 'k', kay: 'k',
    l: 'l', el: 'l', ell: 'l',
    m: 'm', em: 'm',
    n: 'n', en: 'n',
    o: 'o', oh: 'o',
    p: 'p', pee: 'p',
    q: 'q', cue: 'q', queue: 'q', kew: 'q',
    r: 'r', ar: 'r',
    s: 's', es: 's', ess: 's', as: 's', ass: 's',
    t: 't', tee: 't', tea: 't',
    u: 'u', you: 'u', yu: 'u',
    v: 'v', vee: 'v', we: 'v',
    w: 'w', dub: 'w',
    x: 'x', ex: 'x', eggs: 'x', ax: 'x',
    y: 'y', why: 'y', wye: 'y',
    z: 'z', zed: 'z', zee: 'z',
  };

  /** Resolve one spoken token to a letter, or null if it is not one. */
  const letter = tok => LETTER[String(tok).toLowerCase()] || null;

  /* Node names in the deck are upper case for the Dijkstra and flooding
   * walkthroughs (A-F) and lower case for the graph variables (q, s, u-z). */
  const nodeCase = ch => ('abcdef'.includes(ch) ? ch.toUpperCase() : ch);

  /** Greedily split a run of capitals into known acronyms; give up cleanly. */
  function segment(run) {
    const out = [];
    let i = 0;
    while (i < run.length) {
      const hit = ACRONYMS.find(a => run.startsWith(a, i));
      if (!hit) return null;          // unknown letters: leave the run alone
      out.push(cased(hit));
      i += hit.length;
    }
    return out.length > 1 ? out.join(' ') : null;
  }

  // Ordered: longer phrases first so they win over their own substrings.
  const PHRASES = [
    [/\b(bowman|belmont|bellman)[- ](ford|fort|four|for)\b/gi, 'Bellman-Ford'],
    [/\bbel(ford|mont)\b/gi, 'Bellman-Ford'],
    [/\bbowman\b/gi, 'Bellman-Ford'],
    [/\bdyke[- ]?straw\b/gi, 'Dijkstra'],
    [/\bdyk?stra\b/gi, 'Dijkstra'],
    [/\bcycl\w*(\s+to)?\s+(crecy|redundancy)(\s+check)?\b/gi, 'cyclic redundancy check'],
    [/\bcyclic redundancy\b(?!\s+check)/gi, 'cyclic redundancy check'],
    [/\bgo[- ]back[- ](and|in|end|n)\b/gi, 'Go-Back-N'],
    [/\bselect(\s+a|\s+every|ing)\s+repeat\b/gi, 'selective repeat'],
    [/\b(concert|comes|count)\s+to\s+infinity\b/gi, 'count to infinity'],
    [/\bsee\s+idr\b/gi, 'CIDR'],
    [/\bcider\b/gi, 'CIDR'],
    [/\balma\s+system\b/gi, 'autonomous system'],
    [/\b(enter|inter)\s+(es|as)\s+routing\b/gi, 'inter-AS routing'],
    // "distance vector" is a noun (its distance vector, 12x in Module 1) and
    // "distance-vector" an adjective (distance-vector protocol, 24x). One rule
    // per sense; the adjectival one has to run first.
    [/\bdistance[- ](factor|vector)(?=\s+(protocol|routing|algorithm|approach|entry|update|packet))/gi,
      'distance-vector'],
    [/\bdistance\s(factor|vector)\b/gi, 'distance vector'],
    [/\bpoison\s+revers[e]?\b/gi, 'poison reverse'],
    [/\blink\s+state\b/gi, 'link-state'],

    /* ---- Module 1: routing ---- */

    // Dijkstra's, when the recogniser splits the possessive off
    [/\bDijkstra\s+s\b/g, "Dijkstra's"],
    // the deck spells the pair with a hyphen everywhere
    [/\bBellman\s+Ford\b/g, 'Bellman-Ford'],
    // spelled out in full on the protocol table
    [/\bintermediate\s+system\s+to\s+intermediate\s+system\b/gi, 'IS-IS'],
    [/\blink[- ]state\s+(advertisement|database)\b/gi,
      (_, w) => 'Link-State ' + (w.toLowerCase() === 'database' ? 'Database' : 'advertisement')],
    [/\b(count|comes|concert)[- ]to[- ]infinity\b/gi, 'count-to-infinity'],
    [/\b(least|lease)[- ]cost\s+path\b/gi, 'least-cost path'],
    [/\bshortest[- ]path\s+(algorithm|problem)\b/gi, 'shortest-path $1'],
    [/\ball[- ]pairs\b/gi, 'all-pairs'],
    [/\bmulti[- ]home(d)?\b/gi, 'multi-homed'],
    [/\b(into|inter|enter|intra)[- ](es|as|ay ess)\b/gi,
      (_, a) => (/^intra$/i.test(a) ? 'intra' : 'inter') + '-AS'],
    [/\bre[- ]?flooding\b/gi, 're-flooding'],
    [/\b(waited|weighted)\s+graph\b/gi, 'weighted graph'],
    [/\bnext\s+top\b/gi, 'next hop'],
    [/\bpoisoned\s+reverse\b/gi, 'poison reverse'],
    [/\b(alma|anonymous)\s+system\b/gi, 'autonomous system'],
    [/\bsettle\s+set\b/gi, 'settled set'],
    [/\bconversions?\s+(?=of the network|after)/gi, 'convergence '],
    // routers are labelled R1..R5 on the graph slides
    [/\bR\s?(one|two|three|four|five|1|2|3|4|5)\b/g, (_, n) => 'R' + (
      { one: 1, two: 2, three: 3, four: 4, five: 5 }[n.toLowerCase()] || n)],
    [/\bequals\s+infinity\b/gi, '= \u221e'],
  ];

  /* The letter table is not safe after "node" or "router", where the next
   * word is often ordinary English -- "the node we are looking at" must not
   * become "the node v are looking at". Only an unmistakable letter counts
   * there. After "sub" the anchor is strong enough to take the whole table. */
  const SAFE = /^(?:[a-z]|ess|vee|zed|zee|aitch|jay|kay|cee|dee|gee|pee|tee|wye|eff)$/i;

  /* ------------------------------------------------------------------
   * Slide context.
   *
   * This file runs on the deck, so the slide on screen can simply be read --
   * and a repair that is reckless in general is safe once the word is already
   * projected above the caption. "Elsa" is somebody's name until the flooding
   * slide is up, at which point it is certainly an LSA.
   *
   * The lookup is cached against the slide element, so it costs one DOM read
   * per slide change rather than one per caption chunk.
   * ---------------------------------------------------------------- */
  let ctxSlide = null;
  let ctxWords = null;

  /** Lower-case word set of the slide on screen, or null when there is no deck. */
  function slideWords() {
    if (typeof document === 'undefined') return null;
    const el = document.querySelector('.slide.active');
    if (!el) return null;
    if (el !== ctxSlide) {
      ctxSlide = el;
      ctxWords = new Set((el.textContent || '').toLowerCase().match(/[a-z0-9]+/g) || []);
    }
    return ctxWords;
  }

  /* Fallback for when there is no slide to read -- the caption probe, or the
   * moment before the deck's first render. Then the chunk has to speak for
   * itself. */
  const ROUTING = new RegExp('\\b(rout(?:e|er|ers|ing)|link|state|flood\\w*|'
    + 'database|topolog\\w*|hop|neighbour\\w*|neighbor\\w*|protocol|algorithm|'
    + 'node|vector|advertis\\w*|sub)\\b', 'i');

  /* [pattern, replacement, the word that has to be on the slide].
   *
   * Every one of these would be reckless as a blanket rule -- "the extra",
   * "stab" and "deve" are ordinary English. Tying each to a word that is on
   * screen is what makes them safe, and it is why this list can be far more
   * aggressive than PHRASES. */
  const ON_SLIDE = [
    [/\belsa\b/gi, 'LSA', 'lsa'],
    [/\bl\s?s\s?d\s?b\b/gi, 'LSDB', 'lsdb'],
    [/\b(?:the|de)\s+extra\b/gi, 'Dijkstra', 'dijkstra'],
    [/\bdick\s+stra\b/gi, 'Dijkstra', 'dijkstra'],
    [/\bdyke\s+stra\w*/gi, 'Dijkstra', 'dijkstra'],
    [/\bstab\b/gi, 'stub', 'stub'],
    [/\bdeve\b/gi, 'DV', 'dv'],
    [/\bfar\s+warding\b/gi, 'forwarding', 'forwarding'],
    [/\brelaxing\b/gi, 'relaxation', 'relaxation'],
    [/\bconversions?\b/gi, 'convergence', 'converges'],
    [/\bvertices?\b/gi, 'vertices', 'vertices'],
    [/\bpoisoned\b/gi, 'poison', 'poison'],
  ];

  /** Apply the slide-scoped repairs to one chunk. */
  function contextual(text) {
    const words = slideWords();
    let out = text;
    for (const [re, to, need] of ON_SLIDE) {
      const on = words ? words.has(need) : ROUTING.test(out);
      if (on) out = out.replace(re, to);
    }
    return out;
  }

  /* Words that, following an ambiguous letter, mean it was really a pronoun. */
  const PRONOUN = new RegExp('^(?:are|is|was|were|will|would|can|could|should|'
    + 'have|has|had|do|does|did|see|saw|know|knew|want|think|need|look|looked|'
    + 'call|say|said|get|got|go|went|make|made|use|used|talk|mean|meant|might|'
    + 'must|may|just|also|really|already|now|then)\\b', 'i');

  /* ------------------------------------------------------------------
   * Notation.
   *
   * Module 1 runs on d_s(v), p_s(v) and c(s,w). Spoken, those are "d sub s
   * of v" and "c of s comma w" -- and the word "sub" is what makes them
   * recoverable, because it almost never turns up in ordinary lecture
   * speech. Outside these patterns no letter is ever rewritten.
   *
   * Subscripts are written d_s(v) rather than with Unicode subscript
   * characters: those exist for s and x but not for u, v, w, y, z or q, so
   * half the notation in this module would silently fall back anyway.
   * ---------------------------------------------------------------- */
  function notation(text) {
    let out = text;

    // "w" is dictated as two words. Only collapsed when the chunk is already
    // reading as notation, so ordinary "double you" is left alone.
    if (/\b(sub|comma)\b/i.test(out)) {
      out = out.replace(/\bdouble[- ]?(you|u)\b/gi, 'dub');
    }

    // "d sub s star of v" -- the true optimal cost. Before the plain form.
    out = out.replace(/\b([dp])\s+sub\s+(\w+)\s+star\s+of\s+(\w+)\b/gi, (m, f, a, b) => {
      const x = letter(a), y = letter(b);
      return (x && y) ? `${f.toLowerCase()}_${x}*(${y})` : m;
    });

    // "d sub s of v" -> d_s(v)
    out = out.replace(/\b([dp])\s+sub\s+(\w+)\s+(?:of|off)\s+(\w+)\b/gi, (m, f, a, b) => {
      const x = letter(a), y = letter(b);
      return (x && y) ? `${f.toLowerCase()}_${x}(${y})` : m;
    });

    // "d sub s" standing on its own
    out = out.replace(/\b([dp])\s+sub\s+(\w+)/gi, (m, f, a) => {
      const x = letter(a);
      return x ? `${f.toLowerCase()}_${x}` : m;
    });

    // "c of s comma w" -> c(s,w)
    out = out.replace(/\bc\s+(?:of|off)\s+(\w+)\s+(?:comma|coma)\s+(\w+)\b/gi, (m, a, b) => {
      const x = letter(a), y = letter(b);
      return (x && y) ? `c(${x},${y})` : m;
    });

    // "LSA sub A" -> LSA_A
    out = out.replace(/\bLSA\s+sub\s+(\w+)\b/gi, (m, a) => {
      const x = letter(a);
      return x ? `LSA_${x.toUpperCase()}` : m;
    });

    // "node you" -> node u, "router be" -> router B. An ambiguous letter is
    // only taken when the word after it is not the giveaway of the pronoun
    // reading -- "the node we are looking at" has to survive.
    const words = slideWords();
    out = out.replace(/\b(node|router)\s+(\w+)(\s+\w+)?/gi, (m, kind, a, next) => {
      const x = letter(a);
      if (!x) return m;
      if (!SAFE.test(a) && next && PRONOUN.test(next.trim())) return m;
      // the deck is the authority on which nodes exist: if this letter is not
      // labelling anything on screen, it was an ordinary word
      if (words && !words.has(x)) return m;
      return `${kind} ${nodeCase(x)}${next || ''}`;
    });

    return out;
  }

  /**
   * Clean one chunk of recognised speech.
   * Safe on partial/interim text: every rule is local.
   */
  function fixCaption(text) {
    if (!text) return '';
    let out = text;

    // 1. split glued acronym runs, including ones fused to the previous
    //    word ("DijkstraIBGPEBGP"), which a \b-anchored match would miss
    out = out.replace(/([a-z])?([A-Z]{4,})/g, (m, pre, run) => {
      const split = segment(run);
      if (!split) return m;
      return (pre ? pre + ' ' : '') + split;
    });

    // 2. phonetic phrase repairs
    for (const [re, to] of PHRASES) out = out.replace(re, to);

    // 3. repairs licensed by whatever is on the slide right now
    out = contextual(out);

    // 4. notation, on anchored patterns only
    out = notation(out);

    // 5. standalone acronyms that came through lowercase or spaced out
    out = out.replace(/\b(i|e)\s?bgp\b/gi, (_, p) => `${p.toLowerCase()}BGP`);
    out = out.replace(
      /\b(ospf|napt|cidr|bgp|dns|http|tcp|udp|rip|nat|crc|arq|lsdb|lsa|asn|igp|egp)\b/gi,
      a => cased(a.toUpperCase()));

    return out.replace(/\s{2,}/g, ' ').trim();
  }

  window.fixCaption = fixCaption;
})();
