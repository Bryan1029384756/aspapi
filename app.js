import express from "express";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import redis from "redis";
import dotenv from "dotenv";
dotenv.config();

const redisURL = process.env.REDIS_URL;

const app = express();
const port = 3000;

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

let builds = []; // Combined array of builds with branch information

const domain = process.env.DOMAIN; // Replace with your own domain

const PaperUpstreamUrl =
  "https://ci.infernalsuite.com/app/rest/ui/builds?locator=defaultFilter%3Afalse%2Cbranch%3A(policy%3AALL_BRANCHES%2Cname%3A(matchType%3Aequals%2Cvalue%3A(paper_upstream)))%2Cstate%3Afinished%2CbuildType%3A(id%3AAdvancedSlimePaper_Build)%2Cor%3A(personal%3Afalse%2Cand%3A(personal%3Atrue%2Cuser%3Acurrent))%2Cstart%3A0%2Ccount%3A16%2ClookupLimit%3A50000&fields=build(id,changes($locator(count:100),change(id,username,user(id,name,username,avatars))),artifactDependencyChanges(count))";

const MainBuildsUrl =
  "https://ci.infernalsuite.com/app/rest/ui/builds?locator=defaultFilter%3Afalse%2Cbranch%3A(default%3Atrue)%2Cstate%3Afinished%2CbuildType%3A(id%3AAdvancedSlimePaper_Build)%2Cor%3A(personal%3Afalse%2Cand%3A(personal%3Atrue%2Cuser%3Acurrent))%2Cstart%3A0%2Ccount%3A251%2ClookupLimit%3A50000&fields=count,build(id,number,branchName,defaultBranch,queuedDate,startDate,finishDate,history,composite,links(link(type,relativeUrl)),comment(text,timestamp,user(id,name,username)),statusChangeComment(text,timestamp,user(id,name,username)),statusText,status,state,failedToStart,personal,detachedFromAgent,finishOnAgentDate,pinned,pinInfo(text,timestamp,user(id,name,username)),user(id,name,username),customization,canceledInfo(text,user(id,name,username)),agent(name,id,links(link(type,relativeUrl)),environment(osType),typeId,connected,pool(id,name)),tags(tag(name,private),$locator(private:any,owner:current)),artifacts($locator(count:1),count:($optional)),limitedChangesCount($optional),buildType(id,paused,internalId,projectId,name,type,links(link(type,relativeUrl))),snapshot-dependencies(count:(1)))";

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

async function getCookie() {
  try {
    const response = await client.get(
      "https://ci.infernalsuite.com/guestLogin.html?guest=1",
      {
        withCredentials: true,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
        },
      }
    );
  } catch (error) {
    console.error(`Error getting cookie: ${error}`);
  }
}

async function getBuilds(url, branch) {
  try {
    const config = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
        "Cache-Control": "no-cache",
      },
      withCredentials: true,
    };

    const response = await client.get(url, config);

    let data = response.data;
    if (Buffer.isBuffer(data)) {
      data = data.toString();
    } else if (typeof data === "object") {
      data = JSON.stringify(data);
    }

    const test = JSON.parse(data);
    const buildsData = test.build;
    for (const build of buildsData) {
      if (build.id <= 281) continue;
      const buildInfo = {
        id: build.id,
        branch: branch,
        // artifacts_url: domain + "/v1/builds/" + build.id,
      };
      builds.push(buildInfo);
    }
  } catch (error) {
    console.error(`Error getting builds: ${error}`);
  }
}

async function getBuildArtifacts(id) {
  try {
    await getCookie();
    const config = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
        "Cache-Control": "no-cache",
      },
      withCredentials: true,
    };
    const response = await client.get(
      "https://ci.infernalsuite.com/app/rest/ui/builds/id:" +
        id +
        "/artifacts/children/output?fields=file(name,size)&locator=hidden:false",
      config
    );

    let data = response.data;
    if (Buffer.isBuffer(data)) {
      data = data.toString();
    } else if (typeof data === "object") {
      data = JSON.stringify(data);
    }
    const test = JSON.parse(data);
    const files = test.file;

    let artifactUrls = {};
    for (const file of files) {
      artifactUrls[file.name.split("-")[0]] = {
        downloadLink: createDownloadLink(id, file.name),
        size: file.size,
      };
    }
    return JSON.stringify(artifactUrls);
  } catch (error) {
    console.error(`Error getting builds: ${error}`);
  }
}

function createDownloadLink(id, artifact) {
  return domain + "/v1/builds/" + id + "/output/" + artifact;
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

app.get("/v1/builds/:id/output/:artifactId.jar", async (req, res) => {
  let id = req.params.id;
  let artifactId = req.params.artifactId;

  if (id === "latest") {
    // Retrieve the first ID from the builds array
    if (builds.length === 0) {
      console.error("No builds available");
      res.sendStatus(404);
      return;
    }
    const gba = JSON.parse(await getBuildArtifacts(builds[0].id));
    id = builds[0].id;
    artifactId = gba[artifactId].downloadLink.split("/")[5].replace(".jar", "");
  }

  try {
    await getCookie();
    const config = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
        "Cache-Control": "no-cache",
      },
      withCredentials: true,
      responseType: "stream", // Set response type to stream
    };

    const response = await client.get(
      `https://ci.infernalsuite.com/repository/download/AdvancedSlimePaper_Build/${id}:id/output/${artifactId}.jar`,
      config
    );

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
