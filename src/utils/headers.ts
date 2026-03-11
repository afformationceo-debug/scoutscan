/**
 * Realistic HTTP header generation for Instagram scraping
 */

const CHROME_VERSIONS = [
  '120.0.6099.109', '121.0.6167.85', '122.0.6261.94',
  '123.0.6312.86', '124.0.6367.91', '125.0.6422.76',
];

const INSTAGRAM_APP_ID = '936619743392459';

export function getRandomChromeVersion(): string {
  return CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
}

export function generateWebHeaders(csrfToken?: string): Record<string, string> {
  const chromeVersion = getRandomChromeVersion();
  const majorVersion = chromeVersion.split('.')[0];

  const headers: Record<string, string> = {
    'User-Agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-CH-UA': `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not-A.Brand";v="99"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-IG-App-ID': INSTAGRAM_APP_ID,
    'X-Requested-With': 'XMLHttpRequest',
  };

  if (csrfToken) {
    headers['X-CSRFToken'] = csrfToken;
  }

  return headers;
}

export function generateMobileHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Instagram 317.0.0.0.64 Android (33/13; 420dpi; 1080x2340; samsung; SM-S911B; dm3q; qcom; en_US; 562243649)',
    'Accept': '*/*',
    'Accept-Language': 'en-US',
    'Accept-Encoding': 'gzip, deflate',
    'X-IG-App-ID': INSTAGRAM_APP_ID,
    'X-IG-Capabilities': '3brTv10=',
    'X-IG-Connection-Type': 'WIFI',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  };
}
