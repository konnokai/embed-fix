import { describe, expect, it } from "vitest";
import { matchPageUrl, matchPostUrl } from "../../../src/providers/facebook/http";
import { route } from "../../../src/router";

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
    [
      "/groups/884298604928201/?multi_permalinks=29126842193580464&hoisted_section_header_type=recently_seen",
      "group:884298604928201/29126842193580464",
      "/groups/884298604928201/posts/29126842193580464/",
    ],
    ["/groups/somegroup?multi_permalinks=1796616717956421,123", "group:somegroup/1796616717956421", "/groups/somegroup/posts/1796616717956421/"],
    ["/groups/884298604928201/", "group-home:884298604928201", "/groups/884298604928201/"],
    ["/groups/somegroup?ref=share", "group-home:somegroup", "/groups/somegroup/"],
    ["/groups/884298604928201/?multi_permalinks=abc", "group-home:884298604928201", "/groups/884298604928201/"],
    ["/profile.php?id=4&sk=photos", "profile:4", "/profile.php?id=4"],
    ["/people/%E7%8E%8B%E5%B0%8F%E6%98%8E/pfbid02abcXYZ/", "profile:pfbid02abcXYZ", "/people/%E7%8E%8B%E5%B0%8F%E6%98%8E/pfbid02abcXYZ/"],
    ["/people/John-Smith/100012345678901", "profile:100012345678901", "/people/John-Smith/100012345678901"],
    ["/p/%E7%8E%8B%E5%B0%8F%E6%98%8E-100012345678901/", "profile:100012345678901", "/p/%E7%8E%8B%E5%B0%8F%E6%98%8E-100012345678901/"],
    ["/p/John-Smith-100012345678901", "profile:100012345678901", "/p/John-Smith-100012345678901"],
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
    "/profile.php",
    "/profile.php?id=abc",
    "/people/John-Smith",
    "/p/DdEy97xj9P-",
    "/p/Dd-12345678",
  ])("rejects %s", (path) => {
    expect(match(path)).toBeNull();
  });
});

describe("facebook page paths", () => {
  it.each([
    ["/CHUNITHM.International.ver", "profile:CHUNITHM.International.ver", "/CHUNITHM.International.ver"],
    ["/zuck/?ref=embed", "profile:zuck", "/zuck/"],
  ])("matches %s", (path, key, canonical) => {
    expect(matchPageUrl(new URL(path, "https://fb.ebfix.konnokai.me"))).toEqual({ key, params: { path: canonical } });
  });

  it.each(["/favicon.ico", "/robots.txt", "/home.php", "/zuck/about", "/@zuck"])("rejects %s", (path) => {
    expect(matchPageUrl(new URL(path, "https://fb.ebfix.konnokai.me"))).toBeNull();
  });

  it("is served only on the Facebook domain", () => {
    expect(route(new URL("/CHUNITHM.International.ver", "https://fb.ebfix.konnokai.me"))?.ref.key).toBe(
      "profile:CHUNITHM.International.ver",
    );
    expect(route(new URL("/CHUNITHM.International.ver", "https://ebfix.konnokai.me"))).toBeNull();
    expect(route(new URL("/favicon.ico", "https://fb.ebfix.konnokai.me"))).toBeNull();
  });

  it.each(["/watch/?v=abc", "/photo/?fbid=abc", "/groups", "/Reel", "/login", "/marketplace"])(
    "does not treat Facebook's own path %s as a username",
    (path) => {
      expect(route(new URL(path, "https://fb.ebfix.konnokai.me"))).toBeNull();
    },
  );
});
