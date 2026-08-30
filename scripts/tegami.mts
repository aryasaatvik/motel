import { tegami, type TegamiPlugin } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";

import rootPackage from "../package.json" with { type: "json" };

const REPOSITORY = "aryasaatvik/motel";
const PACKAGE_ID = "npm:@aryasaatvik/motel";

const motelTag = (): TegamiPlugin => ({
  name: "motel-tag",
  enforce: "post",
  initPublishPlan({ plan }) {
    const pkg = this.graph.get(PACKAGE_ID);
    const packagePlan = plan.packages.get(PACKAGE_ID);
    if (!pkg?.version || !packagePlan) return;

    packagePlan.git ??= {};
    packagePlan.git.tag = `v${pkg.version}`;
  },
});

if (rootPackage.name !== "@aryasaatvik/motel") throw new Error("unexpected release package");

const paper = tegami({
  ignore: ["motel-web"],
  npm: {
    client: "bun",
    trustedPublish: {
      provider: "github",
      workflow: "publish.yml",
    },
  },
  packages: {
    "@aryasaatvik/motel": {},
  },
  plugins: [
    github({
      repo: REPOSITORY,
      pushTags: true,
      versionPr: {
        branch: "tegami/version-packages",
        base: "dev",
        forceCreate: true,
        create() {
          const version = this.graph.get(PACKAGE_ID)?.version;
          return {
            title: version
              ? `chore(release): prepare Motel ${version}`
              : "chore(release): prepare Motel",
          };
        },
      },
      release: {
        create({ tag }) {
          return { title: tag };
        },
      },
    }),
    motelTag(),
  ],
});

await runCli(paper);
