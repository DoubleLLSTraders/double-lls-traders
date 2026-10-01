export type LegalDoc = "terms" | "privacy";

const UPDATED = "2 October 2026";
const CONTACT = "Use the email on your licence receipt, or the contact on this site.";

function Terms() {
  return (
    <>
      <h1>Terms of Use</h1>
      <p className="legal-meta">Version 2026-10-02 · Last updated {UPDATED}</p>
      <p>These terms cover Double LLS Trading Bot accounts, the API and the MCP server ("the API"). Creating an account or a key means you accept them, along with the <a href="#/privacy">Privacy Policy</a>.</p>

      <h2>1. Your account and key</h2>
      <ul>
        <li>One account per person. Use your real email: it's how we match your purchases and licence.</li>
        <li>Keep your password and API key secret. Don't put a key in public code, URLs or shared chats.</li>
        <li>You can delete your account any time from the <a href="#/account">account page</a>; that removes what it saved on our side.</li>
        <li>You are responsible for everything done with your key, including actions taken by AI agents you connect to it.</li>
        <li>API keys belong to your account; you need to be signed in to create them. If a key leaks, revoke it on your <a href="#/account">account page</a> and create a new one.</li>
      </ul>

      <h2>2. What the API does</h2>
      <ul>
        <li>Market scans and backtests use public Deriv price data and our simulated market.</li>
        <li>Sessions are paper trading: they trade a demo balance on the live feed and never move real money.</li>
        <li>Exported bot files run on your own machine with your own Deriv token. We never ask for, receive or store Deriv tokens.</li>
        <li>Results, scans and backtests are information, not financial advice. You decide whether and how to trade, and you carry the risk of any real trading you do.</li>
      </ul>

      <h2>3. Fair use and limits</h2>
      <ul>
        <li>120 requests a minute per key, 3 running sessions, 50 stored sessions, 24 hours per session. We may change limits to keep the service stable.</li>
        <li>Don't try to break, overload, scrape around or reverse-engineer the service, share keys to get around limits, or use the API for anything unlawful.</li>
        <li>Don't resell API access or present the bot as your own product without a written agreement.</li>
      </ul>

      <h2>4. Availability</h2>
      <p>The API is provided as is. Market data comes from Deriv's public feed and can be interrupted; running sessions may stop if it is. We may change or retire endpoints, giving notice on the Developers page where we can.</p>

      <h2>5. Suspension and ending</h2>
      <p>You can delete your key at any time, which also deletes its data. We may suspend or delete keys that break these terms or put the service at risk.</p>

      <h2>6. Liability</h2>
      <p>To the extent the law allows, we are not liable for trading losses, lost profits, or indirect damages from using the API, its data, or exported bots.</p>

      <h2>7. Changes</h2>
      <p>When these terms change, the version above changes and the Developers page says so. Using the API after a change means you accept the new version.</p>

      <h2>Contact</h2>
      <p>{CONTACT}</p>
    </>
  );
}

function Privacy() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="legal-meta">Last updated {UPDATED}</p>
      <p>This explains what the Double LLS site, test drive and API keep about you, why, and how to remove it.</p>

      <h2>Stored on your device only</h2>
      <ul>
        <li>Bot settings, session history, sound preference and review status (browser storage).</li>
        <li>Your licence details, if you open them on this device.</li>
        <li>Your API key, if you create or check it on the Developers page, and your sign-in token if you have an account. Clearing site data removes all of this.</li>
      </ul>

      <h2>Stored on our server</h2>
      <ul>
        <li><strong>Site usage:</strong> a random visitor ID, device type, language, time zone, the referring page, and which pages and buttons you used. Used to understand and improve the site.</li>
        <li><strong>Purchases:</strong> order details, email, name, and for M-Pesa your phone number, plus the payment reference. Used to issue and recover licences. Card details go straight to PayPal and never reach us.</li>
        <li><strong>Bot update checks:</strong> downloaded bots send their licence key, file type and version to check for updates.</li>
        <li><strong>Accounts:</strong> your email, optional name, a salted scrypt hash of your password (never the password itself), hashes of your sign-in tokens, when you joined and last signed in, and which terms version you accepted. To sync your devices we also keep your bot settings, test-drive sessions (results, recent trades, equity curve) and any licence you add.</li>
        <li><strong>Reviews:</strong> the rating, text and name you choose to post.</li>
        <li><strong>API:</strong> your email, optional name, a one-way hash of your key (never the key itself), when it was created and last used, request count, and which terms version you accepted. For sessions: the settings you chose, the bot's state and open paper positions, results, recent trades and equity curve. Market prices come from Deriv's public feed; nothing about you is sent to Deriv.</li>
      </ul>

      <h2>What we don't keep</h2>
      <ul>
        <li>IP addresses are used briefly in memory for rate limiting and are not saved.</li>
        <li>Deriv tokens and passwords are never sent to us.</li>
        <li>Messages to the in-app AI assistant go to our AI provider (xAI) to generate the answer. We don't store them.</li>
      </ul>

      <h2>How long we keep it</h2>
      <ul>
        <li>Accounts: until you delete them. Sign-ins expire after 30 days; each account keeps its latest 100 sessions.</li>
        <li>Stopped API sessions: 30 days after they stop.</li>
        <li>API keys unused for 12 months are deleted with their data.</li>
        <li>Site events: the most recent 5,000. Visitor records: the most recent 20,000.</li>
        <li>Purchase records are kept as long as needed for licences, support and the law.</li>
      </ul>

      <h2>Your choices</h2>
      <ul>
        <li>Delete your account and everything it saved any time on the <a href="#/account">account page</a>. This is immediate.</li>
        <li>Revoke any API key and its sessions any time on your <a href="#/account">account page</a> or with <code>DELETE /api/v1/me</code>. This is immediate.</li>
        <li>For other data (purchases, reviews, site usage), contact us and we'll export or delete it unless the law requires us to keep it.</li>
      </ul>

      <h2>Sharing</h2>
      <p>We don't sell personal data. It is shared only with the services needed to run the site: payment providers (PayPal, PayHero/M-Pesa), the AI provider for assistant answers, and our hosting.</p>

      <h2>Security</h2>
      <p>Data is kept in our hosting provider's storage (Netlify Blobs), served over HTTPS, and API keys are stored only as SHA-256 hashes. The admin area is password-protected and rate-limited.</p>

      <h2>Contact</h2>
      <p>{CONTACT}</p>
    </>
  );
}

export default function Legal({ doc }: { doc: LegalDoc }) {
  return (
    <div className="co dev">
      <div className="co-glow" />
      <nav className="co-nav">
        <a className="btn ghost" href="#/">‹ Back</a>
        <span className="wordmark">DOUBLE LLS<span>TRADING BOT</span></span>
        <span />
      </nav>
      <article className="legal">
        {doc === "terms" ? <Terms /> : <Privacy />}
        <p className="dev-legal">
          <a href="#/terms">Terms of Use</a> · <a href="#/privacy">Privacy Policy</a> · <a href="#/docs">API docs</a>
        </p>
      </article>
    </div>
  );
}
