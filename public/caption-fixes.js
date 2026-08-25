/* --------------------------------------------------------------------
 * Caption corrections.
 *
 * Speech recognition has no custom vocabulary, so COSC264 terminology comes
 * back wrong in two specific ways. Every entry below was observed in the
 * probe on the actual phone, not guessed at.
 *
 *   1. Acronyms arrive with no word boundaries: "CIDRNAPTOSPF".
 *      The letters are right, so they can be segmented mechanically.
 *
 *   2. Phrases misfire phonetically but consistently: "Bellman-Ford" came
 *      back as Bowman Ford / Belmont Ford / Bowman Fort / Belford and was
 *      never once correct. Consistency is what makes it fixable.
 *
 * Applied on the phone before the text is sent, so the deck just displays.
 * ------------------------------------------------------------------ */
(() => {
  'use strict';

  // Longest first: the segmenter is greedy and HTTPS must beat HTTP.
  const ACRONYMS = [
    'HTTPS', 'ICMP', 'OSPF', 'NAPT', 'CIDR', 'IBGP', 'EBGP', 'HTTP',
    'DHCP', 'IPV4', 'IPV6', 'SMTP', 'IMAP', 'POP3', 'DNS', 'BGP', 'TCP',
    'UDP', 'ARQ', 'CRC', 'MAC', 'LAN', 'WAN', 'MTU', 'TTL', 'ARP', 'NAT',
    'RIP', 'ACK', 'NAK', 'RTT', 'ISP', 'URL', 'IP', 'AS',
  ];

  // How each acronym should finally appear.
  const CASING = { IBGP: 'iBGP', EBGP: 'eBGP', IPV4: 'IPv4', IPV6: 'IPv6', POP3: 'POP3' };
  const cased = a => CASING[a] || a;

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
    [/\bdistance\s+(factor|vector)\b/gi, 'distance vector'],
    [/\bpoison\s+revers[e]?\b/gi, 'poison reverse'],
    [/\blink\s+state\b/gi, 'link-state'],
  ];

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

    // 3. standalone acronyms that came through lowercase or spaced out
    out = out.replace(/\b(i|e)\s?bgp\b/gi, (_, p) => `${p.toLowerCase()}BGP`);
    out = out.replace(/\b(ospf|napt|cidr|bgp|dns|http|tcp|udp|rip|nat|crc|arq)\b/gi,
      a => cased(a.toUpperCase()));

    return out.replace(/\s{2,}/g, ' ').trim();
  }

  window.fixCaption = fixCaption;
})();
