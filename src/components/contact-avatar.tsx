import * as React from "react";
import { getContactPhoto } from "@/lib/commands";

interface ContactAvatarProps {
  handleId: string | null;
  name: string;
  size?: number;
  className?: string;
}

export const ContactAvatar = React.memo(function ContactAvatar({
  handleId,
  name,
  size = 40,
  className = "",
}: ContactAvatarProps) {
  const [photoUrl, setPhotoUrl] = React.useState<string | null>(null);
  const [imgError, setImgError] = React.useState(false);
  const initial = name.charAt(0).toUpperCase() || "?";

  React.useEffect(() => {
    setImgError(false);
    setPhotoUrl(null);
    if (!handleId) return;

    let cancelled = false;
    getContactPhoto(handleId)
      .then((base64) => {
        if (cancelled) return;
        if (base64) setPhotoUrl(`data:image/jpeg;base64,${base64}`);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [handleId]);

  const showImage = photoUrl && !imgError;

  return (
    <div
      className={`shrink-0 rounded-full bg-muted flex items-center justify-center overflow-hidden ${className}`}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <img
          src={photoUrl}
          alt={name}
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        <span
          className="font-medium text-muted-foreground"
          style={{ fontSize: size * 0.35 }}
        >
          {initial}
        </span>
      )}
    </div>
  );
});
