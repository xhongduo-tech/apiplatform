import { useParams } from "react-router-dom";
import { ForumList } from "./forum-list";
import { ForumDetail } from "./forum-detail";

export function Forum() {
  const { postId } = useParams();
  if (postId) return <ForumDetail />;
  return <ForumList />;
}
