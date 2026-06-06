export interface CodeIntelRepoRouteParams {
	repoRoot?: string;
	terms?: string[];
	paths?: string[];
	maxResults?: number;
	offset?: number;
	maxFiles?: number;
	maxMatchesPerFile?: number;
	includeIgnored?: boolean;
	timeoutMs?: number;
}
