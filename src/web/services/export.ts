import * as XLSX from 'xlsx';
import { getJobPostsRaw, getJobProfiles } from './db.js';

export function exportCSV(jobId: string): string {
  const rows = getJobPostsRaw(jobId);
  if (rows.length === 0) return '';

  const headers = [
    'id', 'platform', 'url', 'caption', 'hashtags', 'mentions',
    'likes_count', 'comments_count', 'views_count', 'media_type',
    'timestamp', 'owner_username', 'owner_full_name'
  ];

  const csvRows = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map(h => {
      let val = row[h] ?? '';
      if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
        val = '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

export function exportXLSX(jobId: string): Buffer {
  const posts = getJobPostsRaw(jobId);
  const profiles = getJobProfiles(jobId);

  const wb = XLSX.utils.book_new();

  if (posts.length > 0) {
    const postsData = posts.map(p => ({
      ID: p.id,
      Platform: p.platform,
      URL: p.url,
      Caption: (p.caption || '').substring(0, 200),
      Hashtags: p.hashtags,
      Likes: p.likes_count,
      Comments: p.comments_count,
      Views: p.views_count || '',
      MediaType: p.media_type,
      Timestamp: p.timestamp,
      Owner: p.owner_username,
    }));
    const ws = XLSX.utils.json_to_sheet(postsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Posts');
  }

  if (profiles.length > 0) {
    const profilesData = profiles.map(p => ({
      Platform: p.platform,
      Username: p.username,
      FullName: p.fullName,
      Followers: p.followersCount,
      Following: p.followingCount,
      Posts: p.postsCount,
      EngagementRate: p.engagementRate || '',
      Verified: p.isVerified ? 'Yes' : 'No',
      Bio: (p.bio || '').substring(0, 200),
    }));
    const ws = XLSX.utils.json_to_sheet(profilesData);
    XLSX.utils.book_append_sheet(wb, ws, 'Profiles');
  }

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
