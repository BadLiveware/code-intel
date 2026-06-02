export interface CodeIntelRepoRouteParams {
	repoRoot?: string;
	terms?: string[];
	paths?: string[];
	maxResults?: number;
	maxFiles?: number;
	maxMatchesPerFile?: number;
	timeoutMs?: number;
}
