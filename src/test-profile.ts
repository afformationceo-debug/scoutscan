import { InstagramScraper } from './platforms/instagram/scraper.js';

async function test() {
  const scraper = new InstagramScraper();
  try {
    console.log('Testing profile fetch for @jooshica...');
    const profile = await scraper.getProfile('jooshica');
    console.log('SUCCESS:', {
      username: profile.username,
      followers: profile.followersCount,
      following: profile.followingCount,
      posts: profile.postsCount,
      bio: profile.bio?.slice(0, 80),
    });
  } catch (e) {
    console.error('FAILED:', (e as Error).message);
  }
  await scraper.close();
}

test();
