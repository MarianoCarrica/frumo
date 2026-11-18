/**
 * Classifies hosts/URLs into marketing (low-value for autocapture/replay), app, dev (local,
 * preview, staging) or unknown. Heuristic by design; the report always lists how each host was
 * classified, and users can override with --marketing-url / --app-url / --dev-host.
 */

export type UrlClass = 'marketing' | 'app' | 'dev' | 'unknown';

export interface UrlClassifierOptions {
  /** Regexes matched against the full URL (https://host/path); force "marketing". */
  marketing?: readonly RegExp[];
  /** Regexes matched against the full URL; force "app" (wins over marketing). */
  app?: readonly RegExp[];
  /** Regexes matched against the host (with port); force "dev". */
  dev?: readonly RegExp[];
}

const APP_SUBDOMAINS = new Set([
  'app', 'apps', 'dashboard', 'console', 'my', 'admin', 'portal', 'account', 'accounts', 'studio', 'manage',
  'platform', 'cloud', 'workspace', 'go-app',
]);

const CONTENT_SUBDOMAINS = new Set([
  'www', 'docs', 'doc', 'blog', 'help', 'support', 'learn', 'community', 'developers', 'developer', 'status',
  'changelog', 'news', 'academy', 'resources', 'marketing', 'lp', 'landing', 'info', 'press', 'careers', 'jobs',
]);

/** Path prefixes that are almost always marketing/content pages. */
const MARKETING_PATH =
  /^\/(pricing|plans|blog|articles|news|docs|documentation|guides|tutorials|learn|academy|about|about-us|company|careers|jobs|customers|case-studies|testimonials|features|solutions|use-cases|industries|partners|compare|vs|alternatives|changelog|roadmap|legal|privacy|terms|cookie-policy|security|trust|contact|contact-us|press|media|brand|resources|webinars|podcast|newsletter|lp|landing|book-a-demo|why-[a-z0-9-]+)(\/|$)/i;

/** Path prefixes that are almost always the product itself. */
const APP_PATH =
  /^\/(app|dashboard|account|settings|login|log-in|signin|sign-in|signup|sign-up|register|onboarding|admin|workspace|workspaces|projects?|billing|org|organizations?|reports?|inbox|home)(\/|$)/i;

const STAGING_LABEL = /^(staging|stage|stg|dev|develop|development|preview|qa|uat|test|testing|sandbox|local)(\d+)?$/;
const STAGING_LABEL_PART = /(^|-)(staging|stage|stg|dev|develop|development|preview|qa|uat|test|testing|sandbox)(-|$|\d)/;

export function stripPort(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.lastIndexOf(':');
  return colon > 0 && /^\d+$/.test(h.slice(colon + 1)) ? h.slice(0, colon) : h;
}

/** Why a host looks like local/preview/staging traffic, or null if it doesn't. */
export function devHostReason(hostWithPort: string): string | null {
  const host = stripPort(hostWithPort);
  if (host === '') return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  if (host === '0.0.0.0' || host === '[::1]' || host === '::1') return 'local address';
  if (/^127\./.test(host)) return 'loopback address';
  if (/^10\.\d+\.\d+\.\d+$/.test(host) || /^192\.168\.\d+\.\d+$/.test(host) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) {
    return 'private network address';
  }
  if (/\.(local|test|internal|lan|invalid)$/.test(host)) return 'local-only domain';
  if (/\.(ngrok\.io|ngrok-free\.app|ngrok\.app|ngrok\.dev|trycloudflare\.com|loca\.lt|localtunnel\.me|serveo\.net|devtunnels\.ms)$/.test(host)) {
    return 'tunnel to a dev machine';
  }
  if (/\.(github\.dev|gitpod\.io|csb\.app|stackblitz\.io|webcontainer\.io|replit\.dev)$/.test(host)) return 'cloud dev environment';
  if (host.endsWith('.vercel.app') && (/-git-/.test(host) || /-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/.test(host))) {
    return 'Vercel preview deployment';
  }
  if (host.endsWith('.netlify.app') && /(^deploy-preview-\d+--)|(--)/.test(host)) return 'Netlify deploy preview';
  if (host.endsWith('.pages.dev') && host.split('.').length >= 4) return 'Cloudflare Pages preview';
  if (/-pr-\d+\./.test(host) || /^pr-\d+\./.test(host)) return 'pull-request preview';
  const labels = host.split('.');
  const subLabels = labels.length > 2 ? labels.slice(0, -2) : [];
  for (const label of subLabels) {
    if (STAGING_LABEL.test(label) || STAGING_LABEL_PART.test(label)) return 'staging/dev subdomain';
  }
  return null;
}

export class UrlClassifier {
  private readonly hasDedicatedAppHost: boolean;
  private readonly options: Required<UrlClassifierOptions>;

  /** `knownHosts`: hosts that sent events, used to tell whether the app lives on its own subdomain. */
  constructor(options: UrlClassifierOptions = {}, knownHosts: readonly string[] = []) {
    this.options = { marketing: options.marketing ?? [], app: options.app ?? [], dev: options.dev ?? [] };
    this.hasDedicatedAppHost = knownHosts.some((h) => {
      const first = stripPort(h).split('.')[0] ?? '';
      return APP_SUBDOMAINS.has(first) && devHostReason(h) === null;
    });
  }

  /** Reason a host is dev/preview/staging (user patterns included), or null. */
  devReason(host: string): string | null {
    if (this.options.dev.some((re) => re.test(host))) return 'matches --dev-host';
    return devHostReason(host);
  }

  classify(host: string | null | undefined, path: string | null | undefined): UrlClass {
    const h = (host ?? '').trim().toLowerCase();
    const p = normalizeRawPath(path);
    const url = `https://${h}${p}`;
    if (this.options.app.some((re) => re.test(url))) return 'app';
    if (this.options.marketing.some((re) => re.test(url))) return 'marketing';
    if (h === '') return 'unknown';
    if (this.devReason(h) !== null) return 'dev';

    const bare = stripPort(h);
    const labels = bare.split('.');
    const first = labels[0] ?? '';
    if (labels.length > 2 && APP_SUBDOMAINS.has(first)) return 'app';
    if (labels.length > 2 && CONTENT_SUBDOMAINS.has(first)) {
      // www often also hosts the product (e.g. www.example.com/app); respect obvious app paths.
      return first === 'www' && APP_PATH.test(p) && !this.hasDedicatedAppHost ? 'app' : 'marketing';
    }
    const isApex = labels.length === 2;
    if (MARKETING_PATH.test(p)) return 'marketing';
    if (isApex) {
      if (APP_PATH.test(p)) return 'app';
      // Apex domain next to a dedicated app.* host: the apex is the marketing site.
      return this.hasDedicatedAppHost ? 'marketing' : 'unknown';
    }
    return 'unknown';
  }

  classifyUrl(url: string): UrlClass {
    const parsed = parseUrlLoose(url);
    return parsed ? this.classify(parsed.host, parsed.path) : 'unknown';
  }
}

export function normalizeRawPath(path: string | null | undefined): string {
  if (!path) return '/';
  const p = path.split('?')[0]?.split('#')[0] ?? '/';
  return p.startsWith('/') ? p : `/${p}`;
}

/** Splits "https://host:port/path?query" without throwing on junk. */
export function parseUrlLoose(url: string): { host: string; path: string } | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/i.exec(url.trim());
  if (!m) return null;
  return { host: (m[1] ?? '').toLowerCase(), path: m[2] && m[2] !== '' ? m[2] : '/' };
}

/** Collapses ids in paths for display: /reports/8123/edit → /reports/:id/edit */
export function displayPath(path: string): string {
  return normalizeRawPath(path)
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) || /^(?=.*\d)[0-9a-z_-]{12,}$/i.test(segment)
        ? ':id'
        : segment,
    )
    .join('/');
}
