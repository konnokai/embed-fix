import { describe, expect, it } from "vitest";
import { matchPostUrl } from "../../../src/providers/facebook/http";

function match(path: string) {
  return matchPostUrl(new URL(path, "https://proxy.example"));
}

describe("facebook path rules", () => {
  it.each([
    ["/NASA/posts/1602283071267063", "posts:1602283071267063", "/NASA/posts/1602283071267063"],
    ["/NASA/posts/pfbid02abcXYZ/?mibextid=abc", "posts:pfbid02abcXYZ", "/NASA/posts/pfbid02abcXYZ/"],
    ["/reel/2300161320399228", "video:2300161320399228", "/reel/2300161320399228"],
    ["/zuck/videos/2300161320399228/", "video:2300161320399228", "/zuck/videos/2300161320399228/"],
    ["/zuck/videos/some-slug/2300161320399228/", "video:2300161320399228", "/zuck/videos/some-slug/2300161320399228/"],
    ["/watch/?v=588109690402315&ref=sharing", "video:588109690402315", "/watch/?v=588109690402315"],
    ["/watch?v=588109690402315", "video:588109690402315", "/watch?v=588109690402315"],
    [
      "/story.php?id=100&story_fbid=457992036868931&rdid=x",
      "story:457992036868931",
      "/story.php?story_fbid=457992036868931&id=100",
    ],
    ["/permalink.php?story_fbid=pfbid0abc&id=100", "story:pfbid0abc", "/permalink.php?story_fbid=pfbid0abc&id=100"],
    ["/photo/?fbid=1220500346751179&set=a.459", "photo:1220500346751179", "/photo/?fbid=1220500346751179"],
    ["/photo.php?fbid=1220500346751179", "photo:1220500346751179", "/photo.php?fbid=1220500346751179"],
    ["/groups/1495321534752609/posts/1796616717956421/", "group:1495321534752609/1796616717956421", "/groups/1495321534752609/posts/1796616717956421/"],
    ["/groups/somegroup/permalink/1796616717956421", "group:somegroup/1796616717956421", "/groups/somegroup/permalink/1796616717956421"],
  ])("matches %s", (path, key, canonical) => {
    expect(match(path)).toEqual({ key, params: { path: canonical } });
  });

  it.each([
    "/NASA",
    "/NASA/posts/",
    "/NASA/posts/abc",
    "/reel/abc",
    "/watch/",
    "/watch/?v=abc",
    "/story.php?story_fbid=1",
    "/photo/?fbid=abc",
    "/share/p/1BAxhY4v7c/",
    "/events/123",
  ])("rejects %s", (path) => {
    expect(match(path)).toBeNull();
  });
});
