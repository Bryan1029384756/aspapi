import express from "express";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import redis from "redis";
import dotenv from "dotenv";
import { load } from "cheerio";
dotenv.config();

const redisURL = process.env.REDIS_URL;
const port = process.env.PORT || 3000;

const app = express();
const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

let builds = [];

const PaperUpstreamUrl =
  "https://ci.infernalsuite.com/app/rest/ui/builds?locator=defaultFilter%3Afalse%2Cbranch%3A(policy%3AALL_BRANCHES%2Cname%3A(matchType%3Aequals%2Cvalue%3A(paper_upstream)))%2Cstate%3Afinished%2CbuildType%3A(id%3AAdvancedSlimePaper_Build)%2Cor%3A(personal%3Afalse%2Cand%3A(personal%3Atrue%2Cuser%3Acurrent))%2Cstart%3A0%2Ccount%3A16%2ClookupLimit%3A50000&fields=build(id,changes($locator(count:100),change(id,username,user(id,name,username,avatars))),artifactDependencyChanges(count))";

const MainBuildsUrl =
  "https://ci.infernalsuite.com/app/rest/ui/builds?locator=defaultFilter%3Afalse%2Cbranch%3A(default%3Atrue)%2Cstate%3Afinished%2CbuildType%3A(id%3AAdvancedSlimePaper_Build)%2Cor%3A(personal%3Afalse%2Cand%3A(personal%3Atrue%2Cuser%3Acurrent))%2Cstart%3A0%2Ccount%3A251%2ClookupLimit%3A50000&fields=build(id,changes($locator(count:100),change(id,username,user(id,name,username,avatars))),artifactDependencyChanges(count))";

const redisClient = redis.createClient({
  url: redisURL,
});

(async () => {
  await redisClient.connect();
})();

redisClient.on("connect", (error) => {
  console.log("Connected to Redis");
  loadCacheFromRedis();
  setInterval(updateCache, 30 * 60 * 1000); // 30 Min Cache Reset
});

redisClient.on("error", (error) => {
  console.error("Redis connection error:", error);
});

const config = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
    "Cache-Control": "no-cache",
  },
  withCredentials: true,
};
async function getCookie() {
  try {
    await client.get(
      "https://ci.infernalsuite.com/guestLogin.html?guest=1",
      config
    );
  } catch (error) {
    console.error(`Error getting cookie: ${error}`);
  }
}

async function getBuilds(url, branch) {
  try {
    const response = await client.get(url, config);

    let data = JSON.stringify(response.data);

    const buildData = JSON.parse(data);

    const buildsData = buildData.build;
    for (const build of buildsData) {
      if (build.id <= 283) continue; //Any Builds 281 and under dont have download files that i have seen
      const changeId = build.changes?.change?.[0]?.id; // Accessing change id using optional chaining
      if (!changeId) continue; // Skip if change id is not defined
      const buildInfo = {
        id: build.id,
        changeId: build.changes.change[0].id, // Accessing change id for downloadFile
        branch: branch,
      };
      builds.push(buildInfo);
    }
  } catch (error) {
    console.error(`Error getting builds: ${error}`);
  }
}

async function getRevision(changeId) {
  try {
    await getCookie();

    const url =
      "https://ci.infernalsuite.com/viewModification.html?modId=" +
      changeId +
      "&personal=false&tab=vcsModificationFiles";

    const { data: html } = await client.get(url, config);
    const $ = load(html);
    const text = $(".revisionNum:first").text();

    return text.trim();
  } catch (error) {
    console.error(`Error getting commit hash from HTML: ${error}`);
  }
}

async function getBuildArtifacts(id) {
  try {
    await getCookie();

    const response = await client.get(
      "https://ci.infernalsuite.com/app/rest/ui/builds/id:" +
        id +
        "/artifacts/children/output?fields=file(name,size)&locator=hidden:false",
      config
    );

    let data = JSON.stringify(response.data);

    const artifactData = JSON.parse(data);
    const files = artifactData.file;

    const redisData = await redisClient.get("builds");

    const branch = await getBranch(redisData, id);
    const changeId = await getChangeId(redisData, id);
    const revision = await getRevision(changeId);

    let artifactUrls = {};
    for (const file of files) {
      artifactUrls[file.name.split("-")[0]] = {
        downloadLink: await createDownloadLink(file.name, branch, revision),
        size: file.size,
      };
    }
    return JSON.stringify(artifactUrls);
  } catch (error) {
    console.error(`Error getting Build Artifacts: ${error}`);
  }
}

async function getBranch(redisData, id) {
  try {
    const buildData = JSON.parse(redisData);
    for (const build of buildData) {
      if (build.id == id) {
        return build.branch;
      }
    }
  } catch (error) {
    console.error(`Error loading branch: ${error}`);
    await updateCache();
  }
}

async function getChangeId(redisData, id) {
  try {
    const buildData = JSON.parse(redisData);
    for (const build of buildData) {
      if (build.id == id) {
        return build.changeId;
      }
    }
  } catch (error) {
    console.error(`Error loading changeID: ${error}`);
    await updateCache();
  }
}

async function createDownloadLink(artifact, branch, revision) {
  return (
    "https://dl.rapture.pw/IS/ASP/" + branch + "/" + revision + "/" + artifact
  );
}

async function updateCache() {
  builds = []; // Clear the existing builds
  await getCookie();
  await getBuilds(PaperUpstreamUrl, "paper_upstream");
  await getBuilds(MainBuildsUrl, "main");

  builds.sort((a, b) => b.id - a.id);
  console.log("Cache updated:");

  redisClient.set("builds", JSON.stringify(builds));
}

async function loadCacheFromRedis() {
  try {
    const redisData = await redisClient.get("builds");

    if (redisData) {
      builds = JSON.parse(redisData);
      console.log("Cache loaded from Redis:");
    } else {
      await updateCache();
    }
  } catch (error) {
    console.error(`Error loading cache from Redis: ${error}`);
    await updateCache();
  }
}

app.get("/v1/builds", (req, res) => {
  const prettyBuilds = JSON.stringify(builds, null, 2); // Add prettify formatting
  res.set("Content-Type", "application/json");
  res.send(prettyBuilds);
});

app.get("/v1/builds/latest/output/:artifactId.jar", async (req, res) => {
  let id = req.params.id;
  let artifactId = req.params.artifactId;

  // Retrieve the first ID from the builds array
  if (builds.length === 0) {
    console.error("No builds available");
    res.sendStatus(404);
    return;
  }
  const gba = JSON.parse(await getBuildArtifacts(builds[0].id));
  id = builds[0].id;
  const downloadLink = gba[artifactId].downloadLink;
  try {
    const downloadConfig = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
        "Cache-Control": "no-cache",
      },
      withCredentials: true,
      responseType: "stream", // Set response type to stream
    };

    const response = await client.get(downloadLink, downloadConfig);

    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${artifactId}.jar"`,
    });

    // Pipe the response stream to the API response
    response.data.pipe(res);
  } catch (error) {
    console.error(`Error streaming file: ${error}`);
    res.sendStatus(500);
  }
});

app.get("/v1/builds/:id", async (req, res) => {
  const id = req.params.id;

  try {
    // Check if the result is already cached in Redis
    const redisResult = await redisClient.get(id);

    if (redisResult != null) {
      const prettyResult = JSON.stringify(JSON.parse(redisResult), null, 2);
      res.set("Content-Type", "application/json");
      res.send(prettyResult);
      return;
    }

    const artifactUrlsJSON = await getBuildArtifacts(id);
    const artifactUrls = JSON.parse(artifactUrlsJSON);

    // Cache the result indefinitely in Redis
    redisClient.set(id, JSON.stringify(artifactUrls));

    const prettyResult = JSON.stringify(artifactUrls, null, 2);
    res.set("Content-Type", "application/json");
    res.send(prettyResult);
  } catch (error) {
    console.error(`Error getting build artifacts: ${error}`);
    res.sendStatus(500);
  }
});

app.listen(port, () => {
  console.log(`API server is running on port ${port}`);
});
