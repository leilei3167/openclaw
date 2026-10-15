export async function advanceAuthProfileCandidate<Candidate>(params: {
  candidates: readonly Candidate[];
  state: { profileIndex: number };
  isAvailable(profileId: Candidate, index: number): boolean;
  tryPrepare(profileId: Candidate, index: number): Promise<boolean>;
}): Promise<boolean> {
  while (params.state.profileIndex + 1 < params.candidates.length) {
    const index = params.state.profileIndex + 1;
    // Exhaustion must not depend on credential-health bookkeeping succeeding.
    params.state.profileIndex = index;
    const candidate = params.candidates[index];
    if (params.isAvailable(candidate, index) && (await params.tryPrepare(candidate, index))) {
      return true;
    }
  }
  params.state.profileIndex = params.candidates.length;
  return false;
}
