// Verified AniList GraphQL query strings. Copy verbatim — do not reformat.
// Each string below was executed against https://graphql.anilist.co and
// returned `data` with no errors. Known traps that 400 if you get them wrong:
// - `sort` is `[MediaSort]` (a LIST); a bare `MediaSort` 400s.
// - `MediaTag.category` is a plain String; a sub-selection 400s.
// - The tag spoiler flag is `isMediaSpoiler`; `isSpoiler` / `isMediaRelevant` 400.
// - `studios.edges` are `StudioEdge`, whose flag is `isMain`
//   (`isMainStudio` 400s there; only `relations.edges` use `MediaEdge`).
// - `perPage` is silently clamped to 50; read `pageInfo.perPage`, never assume.

export const CATALOG_QUERY: string =
  'query($perPage:Int,$page:Int,$sort:[MediaSort]){Page(page:$page,perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage perPage} media(sort:$sort,type:ANIME,isAdult:false){id idMal title{romaji english native} format status episodes duration averageScore popularity coverImage{extraLarge large medium color} bannerImage genres season seasonYear startDate{year month day} isAdult nextAiringEpisode{episode airingAt timeUntilAiring}}}}';

export const SEARCH_QUERY: string =
  'query($search:String,$perPage:Int,$page:Int,$sort:[MediaSort]){Page(page:$page,perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage perPage} media(search:$search,type:ANIME,sort:$sort,isAdult:false){id idMal title{romaji english native} coverImage{extraLarge large medium color} format status episodes averageScore genres}}}';

export const META_QUERY: string =
  'query($id:Int){Media(id:$id){id idMal title{romaji english native} synonyms description(asHtml:false) format status episodes duration averageScore meanScore popularity favourites isAdult source countryOfOrigin hashtag startDate{year month day} endDate{year month day} season seasonYear coverImage{extraLarge large medium color} bannerImage genres tags{id name rank category isMediaSpoiler isAdult} studios{edges{isMain node{id name}}} relations{edges{relationType node{id type title{romaji english} format status}}} nextAiringEpisode{episode airingAt timeUntilAiring} siteUrl}}';
