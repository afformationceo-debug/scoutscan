import 'dotenv/config';
import { ScrapingEngine, ExtendedPlatform } from './core/engine.js';
import { InstagramScraper } from './platforms/instagram/index.js';
import { ApifyReference } from './platforms/instagram/apify-reference.js';
import { logger } from './utils/logger.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const HELP = `
Social Scraper v2.0 - World-class social media data extraction
Rivals Apify & Bright Data with self-hosted infrastructure

Usage:
  npx tsx src/index.ts hashtag <tag> [options]      Search posts by hashtag
  npx tsx src/index.ts profile <username> [options]  Get influencer profile
  npx tsx src/index.ts multi <tag> [options]         Multi-platform search
  npx tsx src/index.ts benchmark <tag>               Compare with Apify

Platforms (--platform):
  instagram  (default)  Instagram posts & profiles
  twitter               Twitter/X tweets & profiles
  tiktok                TikTok videos & profiles
  youtube               YouTube videos & channels
  xiaohongshu           Xiaohongshu/RED notes & profiles
  linkedin              LinkedIn posts & profiles

Options:
  --max <number>         Maximum results per platform (default: 50)
  --platform <name>      Target platform (default: instagram)
  --platforms <a,b,c>    Multiple platforms for 'multi' command
  --enrich               Enrich posts with full profile data
  --output <path>        Output file path (default: output/<timestamp>.json)
  --apify                Also fetch from Apify for comparison
  --proxy <url>          Proxy URL (protocol://user:pass@host:port)
  --headless <bool>      Run browser in headless mode (default: true)

Examples:
  npx tsx src/index.ts hashtag travel --max 100
  npx tsx src/index.ts hashtag food --platform instagram --enrich
  npx tsx src/index.ts multi fashion --platforms instagram,tiktok,xiaohongshu --max 30
  npx tsx src/index.ts profile natgeo --platform instagram
  npx tsx src/index.ts benchmark travel --max 50
`;

const ALL_PLATFORMS: ExtendedPlatform[] = ['instagram', 'twitter', 'tiktok', 'youtube', 'xiaohongshu', 'linkedin'];

interface CLIOptions {
  command: string;
  target: string;
  max: number;
  platform: ExtendedPlatform;
  platforms: ExtendedPlatform[];
  enrich: boolean;
  output?: string;
  useApify: boolean;
  proxy?: string;
  headless: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  const options: CLIOptions = {
    command: args[0],
    target: args[1],
    max: 50,
    platform: 'instagram',
    platforms: ['instagram'],
    enrich: false,
    useApify: false,
    headless: true,
  };

  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case '--max':
        options.max = parseInt(args[++i]) || 50;
        break;
      case '--platform':
        options.platform = args[++i] as ExtendedPlatform;
        options.platforms = [options.platform];
        break;
      case '--platforms':
        options.platforms = args[++i].split(',') as ExtendedPlatform[];
        break;
      case '--enrich':
        options.enrich = true;
        break;
      case '--output':
        options.output = args[++i];
        break;
      case '--apify':
        options.useApify = true;
        break;
      case '--proxy':
        options.proxy = args[++i];
        break;
      case '--headless':
        options.headless = args[++i] !== 'false';
        break;
    }
  }

  return options;
}

function saveResults(data: any, outputPath?: string): string {
  const outputDir = join(process.cwd(), 'output');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const filePath = outputPath || join(outputDir, `scrape_${Date.now()}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

async function runHashtagSearch(options: CLIOptions): Promise<void> {
  const proxyUrls = options.proxy
    ? [options.proxy]
    : (process.env.PROXY_URLS || '').split(',').filter(Boolean);

  const engine = new ScrapingEngine({
    proxyUrls,
    platforms: options.platforms,
  });

  try {
    console.log(`\nSearching #${options.target} on ${options.platforms.join(', ')} (max: ${options.max})...\n`);

    if (options.platforms.length === 1 && options.platform === 'instagram' && options.enrich) {
      // Instagram-specific enriched search
      const scraper = new InstagramScraper(proxyUrls);
      const result = await scraper.searchHashtagFull(options.target, {
        maxResults: options.max,
        enrichProfiles: true,
      });

      const output = {
        query: `#${options.target}`,
        platform: 'instagram',
        scrapedAt: new Date().toISOString(),
        totalPosts: result.posts.length,
        totalProfiles: result.profiles.size,
        posts: result.posts,
        profiles: [...result.profiles.values()],
      };

      const filePath = saveResults(output, options.output);
      printResults(output, filePath);
      await scraper.close();
    } else {
      // Single or multi-platform search
      const { posts, errors } = await engine.searchPlatform(
        options.platform,
        options.target,
        { maxResults: options.max }
      );

      const output = {
        query: `#${options.target}`,
        platform: options.platform,
        scrapedAt: new Date().toISOString(),
        totalPosts: posts.length,
        posts,
        errors,
      };

      const filePath = saveResults(output, options.output);
      printResults(output, filePath);
    }

    // Apify comparison
    if (options.useApify && process.env.APIFY_API_KEY) {
      await runApifyComparison(options);
    }
  } finally {
    await engine.close();
  }
}

async function runMultiPlatformSearch(options: CLIOptions): Promise<void> {
  const proxyUrls = options.proxy
    ? [options.proxy]
    : (process.env.PROXY_URLS || '').split(',').filter(Boolean);

  const engine = new ScrapingEngine({
    proxyUrls,
    platforms: options.platforms,
  });

  try {
    console.log(`\nMulti-platform search: #${options.target}`);
    console.log(`Platforms: ${options.platforms.join(', ')}`);
    console.log(`Max per platform: ${options.max}\n`);

    const results = await engine.searchAllPlatforms(options.target, {
      maxResults: options.max,
    });

    const output = {
      query: `#${options.target}`,
      scrapedAt: new Date().toISOString(),
      platforms: results.map(r => ({
        platform: r.platform,
        totalPosts: r.posts.length,
        duration: `${(r.duration / 1000).toFixed(1)}s`,
        errors: r.errors,
        posts: r.posts,
      })),
      summary: {
        totalPosts: results.reduce((sum, r) => sum + r.posts.length, 0),
        totalPlatforms: results.length,
        successfulPlatforms: results.filter(r => r.errors.length === 0).length,
      },
    };

    const filePath = saveResults(output, options.output);

    console.log('\nResults:');
    console.log('═'.repeat(60));
    for (const r of results) {
      const status = r.errors.length === 0 ? 'OK' : 'ERR';
      console.log(
        `  ${r.platform.padEnd(15)} ${String(r.posts.length).padStart(5)} posts  ${(r.duration / 1000).toFixed(1)}s  [${status}]`
      );
      if (r.errors.length > 0) {
        for (const err of r.errors) {
          console.log(`    ${err}`);
        }
      }
    }
    console.log('═'.repeat(60));
    console.log(`  Total: ${output.summary.totalPosts} posts from ${output.summary.successfulPlatforms}/${output.summary.totalPlatforms} platforms`);
    console.log(`\nSaved to: ${filePath}`);
  } finally {
    await engine.close();
  }
}

async function runProfileScrape(options: CLIOptions): Promise<void> {
  const proxyUrls = options.proxy
    ? [options.proxy]
    : (process.env.PROXY_URLS || '').split(',').filter(Boolean);

  const engine = new ScrapingEngine({
    proxyUrls,
    platforms: [options.platform],
  });

  try {
    console.log(`\nScraping ${options.platform} profile: @${options.target}...\n`);

    const profile = await engine.getProfile(options.platform, options.target);

    const filePath = saveResults(profile, options.output);
    console.log(`Profile saved to: ${filePath}\n`);

    console.log('─'.repeat(50));
    console.log(`Platform:    ${profile.platform}`);
    console.log(`Username:    @${profile.username} ${profile.isVerified ? '(verified)' : ''}`);
    console.log(`Name:        ${profile.fullName}`);
    console.log(`Bio:         ${profile.bio.slice(0, 100)}`);
    console.log(`Followers:   ${profile.followersCount.toLocaleString()}`);
    console.log(`Following:   ${profile.followingCount.toLocaleString()}`);
    console.log(`Posts:       ${profile.postsCount.toLocaleString()}`);
    if (profile.engagementRate) {
      console.log(`Eng. Rate:   ${profile.engagementRate.toFixed(2)}%`);
    }
    if (profile.category) {
      console.log(`Category:    ${profile.category}`);
    }
    if (profile.externalUrl) {
      console.log(`Website:     ${profile.externalUrl}`);
    }
    console.log('─'.repeat(50));
  } finally {
    await engine.close();
  }
}

async function runApifyComparison(options: CLIOptions): Promise<void> {
  if (!process.env.APIFY_API_KEY) return;

  console.log('\nFetching Apify results for comparison...');
  const apify = new ApifyReference(process.env.APIFY_API_KEY);
  const apifyPosts = await apify.searchHashtag(options.target, options.max);
  console.log(`Apify returned: ${apifyPosts.length} posts`);

  const comparisonPath = saveResults({
    source: 'apify',
    query: `#${options.target}`,
    totalPosts: apifyPosts.length,
    posts: apifyPosts,
  });
  console.log(`Apify results saved to: ${comparisonPath}`);
}

function printResults(output: any, filePath: string): void {
  console.log(`\nResults saved to: ${filePath}`);
  console.log(`Posts: ${output.totalPosts}`);
  if (output.totalProfiles) {
    console.log(`Profiles: ${output.totalProfiles}`);
  }

  if (output.profiles?.length > 0) {
    const sorted = output.profiles
      .sort((a: any, b: any) => b.followersCount - a.followersCount)
      .slice(0, 10);

    console.log('\nTop Influencers:');
    console.log('─'.repeat(70));
    for (const p of sorted) {
      const er = p.engagementRate ? `${p.engagementRate.toFixed(2)}%` : 'N/A';
      console.log(
        `@${p.username.padEnd(25)} ${String(p.followersCount).padStart(12)} followers  ER: ${er}  ${p.isVerified ? '(verified)' : ''}`
      );
    }
  } else if (output.posts?.length > 0) {
    console.log('\nSample posts:');
    console.log('─'.repeat(70));
    for (const post of output.posts.slice(0, 5)) {
      console.log(`@${post.owner.username}: ${post.caption.slice(0, 80)}...`);
      console.log(`  Likes: ${post.likesCount} | Comments: ${post.commentsCount} | ${post.mediaType}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Social Scraper v2.0 - Enterprise Edition       ║');
  console.log('║  Instagram | Twitter | TikTok | YouTube         ║');
  console.log('║  Xiaohongshu | LinkedIn                         ║');
  console.log('╚══════════════════════════════════════════════════╝');

  try {
    switch (options.command) {
      case 'hashtag':
        await runHashtagSearch(options);
        break;
      case 'profile':
        await runProfileScrape(options);
        break;
      case 'multi':
        await runMultiPlatformSearch(options);
        break;
      case 'benchmark':
        options.useApify = true;
        options.enrich = true;
        await runHashtagSearch(options);
        break;
      default:
        console.log(`Unknown command: ${options.command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (error) {
    logger.error(`Fatal error: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
