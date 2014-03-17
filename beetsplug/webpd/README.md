webpd is a mash-up of the web plugin and the mpd plugin.  The general idea is
that the computer running beets is serving as the actual audio player and
anything that acceses the web UI can control that player.

## Implementation ##

### Threading ###

The following threads exist:

- GstPlayer thread running the glib/gobject mainloop

- Flask short-lived transient request threads, 1 per request.

- Flask long-lived text/event-stream requests generating server-sent events
  surfaced to the web browser via EventSource.  These end up blocked on
  Queues which get stuffed by threads generating the events using flask's
  blinker signal mechanim.  The generators also wake up periodically in order
  emit a heartbeat which provides potential for dead connection cleanup.
