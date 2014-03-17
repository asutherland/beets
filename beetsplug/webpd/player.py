# This file is part of beets.
# Copyright 2013, Adrian Sampson.
#
# Permission is hereby granted, free of charge, to any person obtaining
# a copy of this software and associated documentation files (the
# "Software"), to deal in the Software without restriction, including
# without limitation the rights to use, copy, modify, merge, publish,
# distribute, sublicense, and/or sell copies of the Software, and to
# permit persons to whom the Software is furnished to do so, subject to
# the following conditions:
#
# The above copyright notice and this permission notice shall be
# included in all copies or substantial portions of the Software.

"""Derived from BPD's core server; just the playlist state machine"""
from __future__ import print_function

import re
from string import Template
import traceback
import logging
import random
import time



# Loggers.
global_log = logging.getLogger('beets')


# Gstreamer import error.
class NoGstreamerError(Exception): pass

VOLUME_MIN = 0
VOLUME_MAX = 100


# Generic server infrastructure, implementing the basic protocol.

class BasePlayer(object):
    def __init__(self):
        # Default server values.
        self.random = False
        self.repeat = False
        self.volume = VOLUME_MAX
        self.crossfade = 0
        self.playlist = []
        self.playlist_version = 0
        self.current_index = -1
        self.paused = False

        # Object for random numbers generation
        self.random_obj = random.Random()

    def dict_status(self):
        playing_track_id = None
        if self.current_index != -1:
            playing_track_id = self.playlist[self.current_index].id
        status = {
            'random': self.random,
            'repeat': self.repeat,
            'volume': self.volume,
            'crossfade': self.crossafe,
            'paused': self.paused,
            'playlistIndex': self.current_index,
            'playingTrackId': playing_track_id,
        }
        return status

    def _item_info(self, item):
        """An abstract method that should response lines containing a
        single song's metadata.
        """
        raise NotImplementedError

    def _item_id(self, item):
        """An abstract method returning the integer id for an item.
        """
        raise NotImplementedError

    def _id_to_index(self, track_id):
        """Searches the playlist for a song with the given id and
        returns its index in the playlist.
        """
        track_id = cast_arg(int, track_id)
        for index, track in enumerate(self.playlist):
            if self._item_id(track) == track_id:
                return index
        # Loop finished with no track found.
        raise ArgumentNotFoundError()

    def _random_idx(self):
        """Returns a random index different from the current one.
        If there are no songs in the playlist it returns -1.
        If there is only one song in the playlist it returns 0.
        """
        if len(self.playlist) < 2:
            return len(self.playlist)-1
        new_index = self.random_obj.randint(0, len(self.playlist)-1)
        while new_index == self.current_index:
            new_index = self.random_obj.randint(0, len(self.playlist)-1)
        return new_index

    def _succ_idx(self):
        """Returns the index for the next song to play.
        It also considers random and repeat flags.
        No boundaries are checked.
        """
        if self.repeat:
            return self.current_index
        if self.random:
            return self._random_idx()
        return self.current_index+1

    def _prev_idx(self):
        """Returns the index for the previous song to play.
        It also considers random and repeat flags.
        No boundaries are checked.
        """
        if self.repeat:
            return self.current_index
        if self.random:
            return self._random_idx()
        return self.current_index-1

    def set_vol(self, vol):
        """Set the player's volume level (0-100)."""
        vol = cast_arg(int, vol)
        if vol < VOLUME_MIN or vol > VOLUME_MAX:
            raise Exception(u'volume out of range')
        self.volume = vol

    def set_crossfade(self, crossfade):
        """Set the number of seconds of crossfading."""
        crossfade = cast_arg(int, crossfade)
        if crossfade < 0:
            raise Exception(u'crossfade time must be nonnegative')

    def clear(self):
        """Clear the playlist."""
        self.playlist = []
        self.playlist_version += 1
        self.stop()

    def delete(self, index):
        """Remove the song at index from the playlist."""
        index = cast_arg(int, index)
        try:
            del(self.playlist[index])
        except IndexError:
            raise ArgumentIndexError()
        self.playlist_version += 1

        if self.current_index == index: # Deleted playing song.
            self.stop()
        elif index < self.current_index: # Deleted before playing.
            # Shift playing index down.
            self.current_index -= 1

    def deleteid(self, track_id):
        self.delete(self._id_to_index(track_id))

    def move(self, idx_from, idx_to):
        """Move a track in the playlist."""
        idx_from = cast_arg(int, idx_from)
        idx_to = cast_arg(int, idx_to)
        try:
            track = self.playlist.pop(idx_from)
            self.playlist.insert(idx_to, track)
        except IndexError:
            raise ArgumentIndexError()

        # Update currently-playing song.
        if idx_from == self.current_index:
            self.current_index = idx_to
        elif idx_from < self.current_index <= idx_to:
            self.current_index -= 1
        elif idx_from > self.current_index >= idx_to:
            self.current_index += 1

        self.playlist_version += 1

    def moveid(self, idx_from, idx_to):
        idx_from = self._id_to_index(idx_from)
        return self.move(idx_from, idx_to)

    def swap(self, i, j):
        """Swaps two tracks in the playlist."""
        i = cast_arg(int, i)
        j = cast_arg(int, j)
        try:
            track_i = self.playlist[i]
            track_j = self.playlist[j]
        except IndexError:
            raise ArgumentIndexError()

        self.playlist[j] = track_i
        self.playlist[i] = track_j

        # Update currently-playing song.
        if self.current_index == i:
            self.current_index = j
        elif self.current_index == j:
            self.current_index = i

        self.playlist_version += 1

    def swapid(self, i_id, j_id):
        i = self._id_to_index(i_id)
        j = self._id_to_index(j_id)
        return self.swap(i, j)

    def urlhandlers(self):
        """Indicates supported URL schemes. None by default."""
        pass

    def playlistinfo(self, index=-1):
        """Gives metadata information about the entire playlist or a
        single track, given by its index.
        """
        index = cast_arg(int, index)
        if index == -1:
            for track in self.playlist:
                yield self._item_info(track)
        else:
            try:
                track = self.playlist[index]
            except IndexError:
                raise ArgumentIndexError()
            yield self._item_info(track)
    def playlistid(self, track_id=-1):
        return self.playlistinfo(self._id_to_index(track_id))

    def plchanges(self, version):
        """Sends playlist changes since the given version.

        This is a "fake" implementation that ignores the version and
        just returns the entire playlist (rather like version=0). This
        seems to satisfy many clients.
        """
        return self.playlistinfo()

    def plchangesposid(self, version):
        """Like plchanges, but only sends position and id.

        Also a dummy implementation.
        """
        for idx, track in enumerate(self.playlist):
            yield u'cpos: ' + unicode(idx)
            yield u'Id: ' + unicode(track.id)

    def currentsong(self):
        """Sends information about the currently-playing song.
        """
        if self.current_index != -1: # -1 means stopped.
            track = self.playlist[self.current_index]
            yield self._item_info(track)

    def next(self):
        """Advance to the next song in the playlist."""
        self.current_index = self._succ_idx()
        if self.current_index >= len(self.playlist):
            # Fallen off the end. Just move to stopped state.
            return self.stop()
        else:
            return self.play()

    def cmd_previous(self):
        """Step back to the last song."""
        self.current_index = self._prev_idx()
        if self.current_index < 0:
            return self.stop()
        else:
            return self.play()

    def pause(self, state=None):
        """Set the pause state playback."""
        if state is None:
            self.paused = not self.paused # Toggle.
        else:
            self.paused = cast_arg('intbool', state)

    def play(self, index=-1):
        """Begin playback, possibly at a specified playlist index."""
        index = cast_arg(int, index)

        if index < -1 or index > len(self.playlist):
            raise ArgumentIndexError()

        if index == -1: # No index specified: start where we are.
            if not self.playlist: # Empty playlist: stop immediately.
                return self.stop(conn)
            if self.current_index == -1: # No current song.
                self.current_index = 0 # Start at the beginning.
            # If we have a current song, just stay there.

        else: # Start with the specified index.
            self.current_index = index

        self.paused = False

    def playid(self, track_id=0):
        track_id = cast_arg(int, track_id)
        if track_id == -1:
            index = -1
        else:
            index = self._id_to_index(track_id)
        return self.play(conn, index)

    def stop(self, conn):
        """Stop playback."""
        self.current_index = -1
        self.paused = False

    def seek(self, index, pos):
        """Seek to a specified point in a specified song."""
        index = cast_arg(int, index)
        if index < 0 or index >= len(self.playlist):
            raise ArgumentIndexError()
        self.current_index = index
    def seekid(self, track_id, pos):
        index = self._id_to_index(track_id)
        return self.seek(index, pos)

    def profile(self):
        """Memory profiling for debugging."""
        from guppy import hpy
        heap = hpy().heap()
        print(heap)


# A subclass of the basic player that actually plays music.

class Player(BasePlayer):
    def __init__(self, library, listener):
        try:
            from beetsplug.bpd import gstplayer
        except ImportError as e:
            # This is a little hacky, but it's the best I know for now.
            if e.args[0].endswith(' gst'):
                global_log.error('Gstreamer Python bindings not found.')
                global_log.error('Install "python-gst0.10", "py27-gst-python", '
                                 'or similar package to use BPD.')
                raise NoGstreamerError()
            else:
                raise
        super(Player, self).__init__()
        self.lib = library
        self.player = gstplayer.GstPlayer(self.play_finished)
        self.listener = listener

    def run(self):
        self.player.run()
        super(Player, self).run()

    def play_finished(self):
        """A callback invoked every time our player finishes a
        track.
        """
        self.next(None)


    # Metadata helper functions.

    def _item_info(self, item):
        info_lines = [u'file: ' + item.destination(fragment=True),
                      u'Time: ' + unicode(int(item.length)),
                      u'Title: ' + item.title,
                      u'Artist: ' + item.artist,
                      u'Album: ' + item.album,
                      u'Genre: ' + item.genre,
                     ]

        track = unicode(item.track)
        if item.tracktotal:
            track += u'/' + unicode(item.tracktotal)
        info_lines.append(u'Track: ' + track)

        info_lines.append(u'Date: ' + unicode(item.year))

        try:
            pos = self._id_to_index(item.id)
            info_lines.append(u'Pos: ' + unicode(pos))
        except ArgumentNotFoundError:
            # Don't include position if not in playlist.
            pass

        info_lines.append(u'Id: ' + unicode(item.id))

        return info_lines

    def _item_id(self, item):
        return item.id


    # Playlist manipulation.

    def _add(self, path, send_id=False):
        """Adds a track or directory to the playlist, specified by the
        path. If `send_id`, write each item's id to the client.
        """
        for item in self._all_items(self._resolve_path(path)):
            self.playlist.append(item)
            if send_id:
                yield u'Id: ' + unicode(item.id)
        self.playlist_version += 1

    def add(self, path):
        """Adds a track or directory to the playlist, specified by a
        path.
        """
        return self._add(path, False)

    def addid(self, path):
        """Same as `cmd_add` but sends an id back to the client."""
        return self._add(path, True)


    # Playback control. The functions below hook into the
    # half-implementations provided by the base class. Together, they're
    # enough to implement all normal playback functionality.

    def play(self, index=-1):
        new_index = index != -1 and index != self.current_index
        was_paused = self.paused
        super(Player, self).cmd_play(conn, index)

        if self.current_index > -1: # Not stopped.
            if was_paused and not new_index:
                # Just unpause.
                self.player.play()
                self.listener(self, 'play')
            else:
                self.player.play_file(self.playlist[self.current_index].path)
                self.listener(self, 'track')

    def cmd_pause(self, state=None):
        super(Player, self).pause(state)
        if self.paused:
            self.player.pause()
            self.listener(self, 'pause')
        elif self.player.playing:
            self.player.play()
            self.listener(self, 'play')
        
    def stop(self):
        super(Player, self).stop()
        self.player.stop()
        self.listener(self, 'stopped')

    def seek(self, index, pos):
        """Seeks to the specified position in the specified song."""
        index = cast_arg(int, index)
        pos = cast_arg(int, pos)
        super(Player, self).seek(index, pos)
        self.player.seek(pos)
        self.listener(self, 'seeked')


    # Volume control.

    def set_vol(self, vol):
        vol = cast_arg(int, vol)
        super(Player, self).set_vol(vol)
        self.player.volume = float(self.volume)/100
        self.listener(self, 'volumechange')
