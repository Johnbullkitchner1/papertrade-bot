// Papertrade's trade-history route sends no CORS headers, so the page reads it through here.
const WALLET = '0x5bab81bb7e099e8d5d45a20ccef5b90415f4719a';
const API = 'https://exchange.papertrade.xyz';

export default async function handler(req, res) {
  try {
    const items = [];
    let cursor = null;
    for (let i = 0; i < 80; i++) {
      const r = await fetch(`${API}/query/accounts/${WALLET}/trades?${cursor ? `cursor=${cursor}&` : ''}limit=75`, {
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`Papertrade answered ${r.status}`);
      const d = await r.json();
      items.push(...d.items);
      cursor = d.nextCursor;
      if (!cursor || !d.items.length) break;
    }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ items });
  } catch (e) {
    res.status(502).json({ error: String(e.message ?? e) });
  }
}
