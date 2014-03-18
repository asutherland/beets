"""Using the various empty variants in rsrc as a base, create other fixtures
based on master_rsrc_files.yaml.
"""

import fnmatch
import os
import os.path
import shutil
import yaml

# import and monkeypatch certain ID3 frame types so that they do not normalize
# the values we place into them.  Note that while this helps us get the values
# into the mp3 file, there is no guarantee that we will ever be able to read
# them as such.  For example, the TDRC TimeStampTextFrame will discard the
# illegal values we force inside the file.  You can see the string in the file,
# but it will be wrong.

import mutagen._id3frames as id3frames
from mutagen._id3specs import EncodingSpec, EncodedTextSpec, MultiSpec
# TimeStampTextFrame insists on normalizing things.  While it's too late for us
# to swap the type out, we can clobber it to pass things through.

id3frames.TimeStampTextFrame._framespec = [
    EncodingSpec('encoding'),
    MultiSpec('text', EncodedTextSpec('text'), sep=u','),
]
# __str__ is always the same and always boring
def identity_string(self):
    return u''.join(self.text)
id3frames.TimeStampTextFrame.__unicode__ = identity_string
id3frames.TimeStampTextFrame._pprint = identity_string

from beets.mediafile import MediaFile

RSRC_DIR = 'rsrc'

def load_fixture_defs():
    with open('master_rsrc_files.yaml', 'r') as f:
        return yaml.load(f)

def get_empty_files():
    return fnmatch.filter(os.listdir(RSRC_DIR), 'empty.*')

def generate_fixture(empty_name, target_name, mapping):
    # copy the empty file to the desired targer
    src_path = os.path.join(RSRC_DIR, empty_name)
    # don't use splitext because "empty.alac.m4a" gets split to ("empty.alac",
    # ".mp4") and what we want is roughly ("empty", ".alac.mp4")
    dest_filename = target_name + '.' + empty_name.split('.', 1)[1]
    dest_path = os.path.join(RSRC_DIR, dest_filename)
    print '  Generating', dest_path, 'from', src_path
    shutil.copyfile(src_path, dest_path)

    # open the file as a mediafile
    mediafile = MediaFile(dest_path)

    for key, value in mapping.iteritems():
        # get the descriptor and bypass the convenience setters to go to the
        # raw setter.
        desc = MediaFile.__dict__['date']
        super(type(desc), desc).__set__(mediafile, value)

    mediafile.save()
    

if __name__ == '__main__':
    # figure out target base names and what should set in them
    defs = load_fixture_defs()
    # use the "empty" files as our template
    empties = get_empty_files()
    for name, mapping in defs.iteritems():
        print '-----', name
        for empty in empties:
            generate_fixture(empty, name, mapping)
