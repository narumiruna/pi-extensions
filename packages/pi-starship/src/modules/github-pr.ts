import { defineModule } from "./types.js";

export const githubPrModule = defineModule({
  name: "github_pr",
  variables: ["symbol", "number", "link", "state", "checks", "review", "status"],
  defaults: {
    format: "[ $symbol$link( · $status) ]($style)",
    symbol: "PR ",
    style: "bold blue",
    disabled: false,
  },
  values: ({ runtime }) => {
    const snapshot = runtime.githubPr;
    if (!snapshot) return undefined;
    return {
      number: snapshot.number,
      link: snapshot.link,
      state: snapshot.state,
      checks: snapshot.checks,
      review: snapshot.review,
      status: snapshot.status,
    };
  },
});
