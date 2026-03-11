/** Instagram GraphQL query document IDs / hashes (subject to change) */
export const QUERY_HASHES = {
  // Hashtag search - top and recent posts
  hashtagPosts: 'aea4d4902b8d03f6145747c04a7862e8',
  // User profile info
  userInfo: 'c9100bf9110dd6361671f113dd02e7d6',
  // User media (posts)
  userMedia: '69cba40317214236af40e7efa697781d',
  // Post details
  postDetails: '2b0673e0dc4580674a88d426fe00ea90',
  // User followers
  followers: 'c76146de99bb02f6415203be841dd25a',
  // User following
  following: 'd04b0a864b4b54837c0d870b0e77e076',
} as const;

export const INSTAGRAM_BASE_URL = 'https://www.instagram.com';
export const INSTAGRAM_GRAPHQL_URL = `${INSTAGRAM_BASE_URL}/graphql/query/`;
export const INSTAGRAM_API_V1_URL = `${INSTAGRAM_BASE_URL}/api/v1`;

/** Known document IDs for newer GraphQL endpoint */
export const DOC_IDS = {
  hashtagMedia: '9b498c08113f1a09f2d47a01f27574b6',
  userProfileInfo: '7c16654f22c819fb63d1183034a5162f',
  webProfileInfo: '71d52f26e56fa31af4cd623aa10e5b5c',
};
