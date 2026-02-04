SELECT DISTINCT code, count(*) as cnt FROM transactions GROUP BY code ORDER BY cnt DESC LIMIT 20;
