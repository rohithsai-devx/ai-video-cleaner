-- 05: the API records the browser-made poster (videos/{id}/poster.jpg) when it confirms an upload.
-- Column grant only; RLS policy v_upd already scopes the row.
grant update (poster_uri) on videos to app_api;
