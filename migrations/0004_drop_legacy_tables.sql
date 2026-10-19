-- 0001 的舊表。0002 已把資料搬到 posts / post_versions，新程式不再讀寫。
-- 套用前確認過：舊表每一筆在新表都有，而且沒有比新表新的資料。

DROP TABLE article_versions;
DROP TABLE articles;
